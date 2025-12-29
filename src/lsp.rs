//! LSP-compatible code completion module
//!
//! Provides completion for:
//! - File paths (relative to markdown file)
//! - Block names (name= and out= directives)
//! - Shell commands (via bash compgen)
//! - Shell history (via atuin if available)

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

/// LSP Completion Item Kind (subset of LSP spec)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompletionItemKind {
    File,
    Folder,
    Variable,
    Function,
    Text,
}

/// A single completion item
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: CompletionItemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_text: Option<String>,
}

/// Type of completion context
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionContextType {
    FilePath,
    BlockName,
    ShellCommand,
    History,
}

/// Completion request context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionContext {
    pub context_type: CompletionContextType,
    pub prefix: String,
    #[serde(default)]
    pub document: Option<String>,
}

/// Completion response
#[derive(Debug, Clone, Serialize)]
pub struct CompletionResponse {
    pub items: Vec<CompletionItem>,
    pub is_incomplete: bool,
}

const MAX_RESULTS: usize = 50;

// =============================================================================
// Filepath Completer
// =============================================================================

pub struct FilepathCompleter;

impl FilepathCompleter {
    /// Complete file paths relative to the markdown file's directory
    pub fn complete(
        worktree_path: &Path,
        markdown_path: &str,
        prefix: &str,
    ) -> Vec<CompletionItem> {
        let mut items = Vec::new();

        // Get the directory containing the markdown file
        let md_dir = Path::new(markdown_path)
            .parent()
            .unwrap_or(Path::new(""));

        // Parse prefix to determine search directory and filter
        let (search_rel, filter) = Self::parse_prefix(prefix);

        // Resolve search directory relative to markdown file's directory
        let search_dir = worktree_path.join(md_dir).join(&search_rel);

        if !search_dir.exists() || !search_dir.is_dir() {
            return items;
        }

        // List entries in search directory
        let entries = match std::fs::read_dir(&search_dir) {
            Ok(e) => e,
            Err(_) => return items,
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files
            if name.starts_with('.') {
                continue;
            }

            // Filter by prefix (case-insensitive)
            if !filter.is_empty() && !name.to_lowercase().starts_with(&filter.to_lowercase()) {
                continue;
            }

            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

            // Build the completion insert text
            let insert_text = format!(
                "{}{}{}",
                search_rel,
                name,
                if is_dir { "/" } else { "" }
            );

            items.push(CompletionItem {
                label: name,
                kind: if is_dir {
                    CompletionItemKind::Folder
                } else {
                    CompletionItemKind::File
                },
                detail: Some(if is_dir { "Directory" } else { "File" }.to_string()),
                insert_text: Some(insert_text),
            });
        }

        // Sort: directories first, then alphabetically
        items.sort_by(|a, b| match (&a.kind, &b.kind) {
            (CompletionItemKind::Folder, CompletionItemKind::File) => std::cmp::Ordering::Less,
            (CompletionItemKind::File, CompletionItemKind::Folder) => std::cmp::Ordering::Greater,
            _ => a.label.to_lowercase().cmp(&b.label.to_lowercase()),
        });

        items.truncate(MAX_RESULTS);
        items
    }

    /// Parse prefix like "./src/m" into ("./src/", "m")
    fn parse_prefix(prefix: &str) -> (String, String) {
        // Normalize: ensure starts with ./
        let normalized = if prefix.starts_with("./") {
            prefix.to_string()
        } else if prefix.starts_with('/') {
            format!(".{}", prefix)
        } else {
            format!("./{}", prefix)
        };

        // Find last "/" to split directory from filter
        if let Some(idx) = normalized.rfind('/') {
            let dir = &normalized[..=idx];
            let filter = &normalized[idx + 1..];
            (dir.to_string(), filter.to_string())
        } else {
            ("./".to_string(), normalized)
        }
    }
}

// =============================================================================
// Block Name Completer
// =============================================================================

pub struct BlockNameCompleter;

impl BlockNameCompleter {
    /// Extract block names from markdown document
    pub fn complete(document: &str, prefix: &str) -> Vec<CompletionItem> {
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        // Use regex to find name=blockname in code fence info strings
        let re = match regex::Regex::new(r"```\w*[^\n]*\bname=([^\s`]+)") {
            Ok(r) => r,
            Err(_) => return items,
        };

        for cap in re.captures_iter(document) {
            if let Some(name_match) = cap.get(1) {
                let name = name_match.as_str();

                // Skip if already seen
                if seen.contains(name) {
                    continue;
                }
                seen.insert(name.to_string());

                // Filter by prefix (case-insensitive)
                if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
                    continue;
                }

                items.push(CompletionItem {
                    label: name.to_string(),
                    kind: CompletionItemKind::Variable,
                    detail: Some("Named block".to_string()),
                    insert_text: Some(name.to_string()),
                });
            }
        }

        items.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        items.truncate(MAX_RESULTS);
        items
    }
}

// =============================================================================
// Shell Command Completer
// =============================================================================

pub struct ShellCompleter;

impl ShellCompleter {
    /// Use bash compgen for shell completions
    pub fn complete(prefix: &str, working_dir: Option<&Path>) -> Vec<CompletionItem> {
        let mut items = Vec::new();

        // Determine completion type based on prefix
        let compgen_opts = if prefix.contains('/') || prefix.starts_with('.') {
            "-f" // File/directory completion
        } else if prefix.starts_with('$') {
            "-v" // Variable completion
        } else {
            "-abc" // Alias, builtin, command
        };

        // Build command
        let script = format!("compgen {} -- '{}'", compgen_opts, prefix.replace('\'', "'\\''"));
        let mut cmd = Command::new("bash");
        cmd.args(["-c", &script]);

        if let Some(dir) = working_dir {
            if dir.exists() {
                cmd.current_dir(dir);
            }
        }

        // Execute and parse output
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    // Determine kind
                    let kind = if compgen_opts == "-f" {
                        if working_dir
                            .map(|d| d.join(trimmed).is_dir())
                            .unwrap_or(false)
                        {
                            CompletionItemKind::Folder
                        } else {
                            CompletionItemKind::File
                        }
                    } else if compgen_opts == "-v" {
                        CompletionItemKind::Variable
                    } else {
                        CompletionItemKind::Function
                    };

                    items.push(CompletionItem {
                        label: trimmed.to_string(),
                        kind,
                        detail: None,
                        insert_text: Some(trimmed.to_string()),
                    });

                    if items.len() >= MAX_RESULTS {
                        break;
                    }
                }
            }
        }

        items
    }
}

// =============================================================================
// Atuin History Completer
// =============================================================================

pub struct AtuinCompleter;

impl AtuinCompleter {
    /// Check if Atuin is available
    pub fn is_available() -> bool {
        Command::new("atuin")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Search Atuin history
    pub fn complete(prefix: &str) -> Vec<CompletionItem> {
        let mut items = Vec::new();

        if prefix.is_empty() {
            return items;
        }

        // Use atuin search command
        let output = Command::new("atuin")
            .args(["search", "--limit", "20", "--format", "{command}", prefix])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut seen = HashSet::new();

                for line in stdout.lines() {
                    let cmd = line.trim();
                    if cmd.is_empty() || seen.contains(cmd) {
                        continue;
                    }
                    seen.insert(cmd.to_string());

                    items.push(CompletionItem {
                        label: cmd.to_string(),
                        kind: CompletionItemKind::Text,
                        detail: Some("History".to_string()),
                        insert_text: Some(cmd.to_string()),
                    });

                    if items.len() >= MAX_RESULTS {
                        break;
                    }
                }
            }
        }

        items
    }
}

// =============================================================================
// LSP Handler
// =============================================================================

use std::sync::Arc;
use crate::config::ConfigManager;

pub struct LspHandler {
    config: Arc<ConfigManager>,
}

impl LspHandler {
    pub fn new(config: Arc<ConfigManager>) -> Self {
        Self { config }
    }

    pub fn handle_completion(
        &self,
        workspace: &str,
        branch: &str,
        markdown_path: &str,
        context: CompletionContext,
    ) -> CompletionResponse {
        let items = match context.context_type {
            CompletionContextType::FilePath => {
                if self.config.get_workspace(workspace).is_some() {
                    let worktree_path = self.config.worktree_path(workspace, branch);
                    FilepathCompleter::complete(&worktree_path, markdown_path, &context.prefix)
                } else {
                    Vec::new()
                }
            }

            CompletionContextType::BlockName => {
                let document = context.document.unwrap_or_default();
                BlockNameCompleter::complete(&document, &context.prefix)
            }

            CompletionContextType::ShellCommand => {
                let working_dir = if self.config.get_workspace(workspace).is_some() {
                    Some(self.config.worktree_path(workspace, branch))
                } else {
                    None
                };
                ShellCompleter::complete(&context.prefix, working_dir.as_deref())
            }

            CompletionContextType::History => {
                if AtuinCompleter::is_available() {
                    AtuinCompleter::complete(&context.prefix)
                } else {
                    Vec::new()
                }
            }
        };

        CompletionResponse {
            is_incomplete: items.len() >= MAX_RESULTS,
            items,
        }
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // -------------------------------------------------------------------------
    // FilepathCompleter Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_filepath_complete_empty_dir() {
        let temp = TempDir::new().unwrap();
        let items = FilepathCompleter::complete(temp.path(), "", "./");
        assert!(items.is_empty());
    }

    #[test]
    fn test_filepath_complete_lists_files() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("README.md"), "# Test").unwrap();
        fs::write(temp.path().join("main.rs"), "fn main() {}").unwrap();

        let items = FilepathCompleter::complete(temp.path(), "", "./");

        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.label == "README.md"));
        assert!(items.iter().any(|i| i.label == "main.rs"));
    }

    #[test]
    fn test_filepath_complete_with_prefix() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("main.rs"), "").unwrap();
        fs::write(temp.path().join("module.rs"), "").unwrap();
        fs::write(temp.path().join("test.rs"), "").unwrap();

        let items = FilepathCompleter::complete(temp.path(), "", "./m");

        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.label.starts_with('m')));
    }

    #[test]
    fn test_filepath_complete_subdirectory() {
        let temp = TempDir::new().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/lib.rs"), "").unwrap();
        fs::write(temp.path().join("src/main.rs"), "").unwrap();

        let items = FilepathCompleter::complete(temp.path(), "", "./src/");

        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.label == "lib.rs"));
    }

    #[test]
    fn test_filepath_complete_skips_hidden() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join(".hidden"), "").unwrap();
        fs::write(temp.path().join("visible.txt"), "").unwrap();

        let items = FilepathCompleter::complete(temp.path(), "", "./");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "visible.txt");
    }

    #[test]
    fn test_filepath_complete_folders_first() {
        let temp = TempDir::new().unwrap();
        fs::create_dir(temp.path().join("zz_dir")).unwrap();
        fs::write(temp.path().join("aa_file.txt"), "").unwrap();

        let items = FilepathCompleter::complete(temp.path(), "", "./");

        assert_eq!(items[0].label, "zz_dir");
        assert_eq!(items[0].kind, CompletionItemKind::Folder);
    }

    #[test]
    fn test_filepath_complete_relative_to_markdown() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("docs")).unwrap();
        fs::write(temp.path().join("docs/guide.md"), "").unwrap();
        fs::write(temp.path().join("README.md"), "").unwrap();

        // Complete from perspective of docs/guide.md
        let items = FilepathCompleter::complete(temp.path(), "docs/guide.md", "../");

        assert!(items.iter().any(|i| i.label == "README.md"));
    }

    #[test]
    fn test_filepath_complete_nonexistent_dir() {
        let temp = TempDir::new().unwrap();
        let items = FilepathCompleter::complete(temp.path(), "", "./nonexistent/");
        assert!(items.is_empty());
    }

    #[test]
    fn test_filepath_parse_prefix() {
        assert_eq!(
            FilepathCompleter::parse_prefix("./src/m"),
            ("./src/".to_string(), "m".to_string())
        );
        assert_eq!(
            FilepathCompleter::parse_prefix("./"),
            ("./".to_string(), "".to_string())
        );
        assert_eq!(
            FilepathCompleter::parse_prefix("src"),
            ("./".to_string(), "src".to_string())
        );
    }

    // -------------------------------------------------------------------------
    // BlockNameCompleter Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_block_name_extract_names() {
        let doc = r#"
# Test Document

```sh name=build
echo "building"
```

```python name=setup
print("setup")
```
"#;

        let items = BlockNameCompleter::complete(doc, "");

        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.label == "build"));
        assert!(items.iter().any(|i| i.label == "setup"));
    }

    #[test]
    fn test_block_name_filter_by_prefix() {
        let doc = r#"
```sh name=build_dev
```
```sh name=build_prod
```
```sh name=test
```
"#;

        let items = BlockNameCompleter::complete(doc, "build");

        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.label.starts_with("build")));
    }

    #[test]
    fn test_block_name_deduplicate() {
        let doc = r#"
```sh name=myblock
first
```
```sh name=myblock
duplicate
```
"#;

        let items = BlockNameCompleter::complete(doc, "");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "myblock");
    }

    #[test]
    fn test_block_name_empty_document() {
        let items = BlockNameCompleter::complete("", "");
        assert!(items.is_empty());
    }

    #[test]
    fn test_block_name_no_matches() {
        let doc = r#"
```sh name=build
```
"#;
        let items = BlockNameCompleter::complete(doc, "xyz");
        assert!(items.is_empty());
    }

    #[test]
    fn test_block_name_with_other_attributes() {
        let doc = r#"
```bash session=dev name=compile out=result
echo "test"
```
"#;

        let items = BlockNameCompleter::complete(doc, "");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "compile");
    }

    // -------------------------------------------------------------------------
    // ShellCompleter Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shell_complete_echo() {
        let items = ShellCompleter::complete("ech", None);
        // 'echo' should be in completions (it's a builtin)
        assert!(items.iter().any(|i| i.label == "echo"));
    }

    #[test]
    fn test_shell_complete_empty_prefix() {
        let items = ShellCompleter::complete("", None);
        // Empty prefix with -abc returns many results, but we limit to MAX_RESULTS
        assert!(items.len() <= MAX_RESULTS);
    }

    #[test]
    fn test_shell_complete_file_prefix() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("testfile.txt"), "").unwrap();

        let items = ShellCompleter::complete("./test", Some(temp.path()));

        // Should find testfile.txt
        assert!(items.iter().any(|i| i.label.contains("testfile")));
    }

    #[test]
    fn test_shell_complete_nonexistent_command() {
        let items = ShellCompleter::complete("zzzznonexistent123", None);
        assert!(items.is_empty());
    }

    // -------------------------------------------------------------------------
    // AtuinCompleter Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_atuin_availability_check() {
        // Just ensure this doesn't panic
        let _ = AtuinCompleter::is_available();
    }

    #[test]
    fn test_atuin_empty_prefix() {
        // Empty prefix should return empty results
        let items = AtuinCompleter::complete("");
        assert!(items.is_empty());
    }

    // -------------------------------------------------------------------------
    // Integration Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_completion_item_serialization() {
        let item = CompletionItem {
            label: "test".to_string(),
            kind: CompletionItemKind::File,
            detail: Some("A test file".to_string()),
            insert_text: Some("./test".to_string()),
        };

        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"label\":\"test\""));
        assert!(json.contains("\"kind\":\"file\""));
    }

    #[test]
    fn test_completion_context_deserialization() {
        let json = r#"{
            "context_type": "file_path",
            "prefix": "./src/"
        }"#;

        let ctx: CompletionContext = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.context_type, CompletionContextType::FilePath);
        assert_eq!(ctx.prefix, "./src/");
        assert!(ctx.document.is_none());
    }

    #[test]
    fn test_completion_response_serialization() {
        let response = CompletionResponse {
            items: vec![CompletionItem {
                label: "test".to_string(),
                kind: CompletionItemKind::File,
                detail: None,
                insert_text: None,
            }],
            is_incomplete: false,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"is_incomplete\":false"));
        assert!(json.contains("\"items\""));
    }
}
