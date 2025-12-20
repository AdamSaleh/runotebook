use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

/// List files in a directory (recursively for markdown files)
pub fn list_files(base_path: &Path, relative_path: Option<&str>) -> Result<Vec<FileEntry>, std::io::Error> {
    let target_path = match relative_path {
        Some(rel) => base_path.join(rel),
        None => base_path.to_path_buf(),
    };

    list_files_recursive(&target_path, base_path)
}

fn list_files_recursive(dir: &Path, base_path: &Path) -> Result<Vec<FileEntry>, std::io::Error> {
    let mut entries = Vec::new();

    if !dir.exists() || !dir.is_dir() {
        return Ok(entries);
    }

    let mut dir_entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .collect();

    // Sort entries: directories first, then files, alphabetically
    dir_entries.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);

        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for entry in dir_entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and .git directory
        if name.starts_with('.') {
            continue;
        }

        let relative = path
            .strip_prefix(base_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let is_dir = path.is_dir();

        if is_dir {
            // Recursively list directory contents
            let children = list_files_recursive(&path, base_path)?;

            // Only include directories that contain markdown files (directly or nested)
            if has_markdown_files(&children) {
                entries.push(FileEntry {
                    name,
                    path: relative,
                    is_dir: true,
                    children: Some(children),
                });
            }
        } else if name.ends_with(".md") || name.ends_with(".markdown") {
            // Include markdown files
            entries.push(FileEntry {
                name,
                path: relative,
                is_dir: false,
                children: None,
            });
        }
    }

    Ok(entries)
}

/// Check if file entries contain any markdown files
fn has_markdown_files(entries: &[FileEntry]) -> bool {
    entries.iter().any(|e| {
        if e.is_dir {
            e.children.as_ref().map(|c| has_markdown_files(c)).unwrap_or(false)
        } else {
            true // Non-directory entries are already filtered to markdown files
        }
    })
}

/// Read file content
pub fn read_file(base_path: &Path, file_path: &str) -> Result<String, std::io::Error> {
    let full_path = safe_join(base_path, file_path)?;

    if !full_path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File not found: {}", file_path),
        ));
    }

    fs::read_to_string(&full_path)
}

/// Write file content
pub fn write_file(base_path: &Path, file_path: &str, content: &str) -> Result<(), std::io::Error> {
    let full_path = safe_join(base_path, file_path)?;

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(&full_path, content)
}

/// Create a new file
pub fn create_file(base_path: &Path, file_path: &str, content: Option<&str>) -> Result<(), std::io::Error> {
    let full_path = safe_join(base_path, file_path)?;

    if full_path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("File already exists: {}", file_path),
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let default_content = format!(
        "# {}\n\nNew runbook created.\n",
        full_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
    );

    fs::write(&full_path, content.unwrap_or(&default_content))
}

/// Delete a file
pub fn delete_file(base_path: &Path, file_path: &str) -> Result<(), std::io::Error> {
    let full_path = safe_join(base_path, file_path)?;

    if !full_path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File not found: {}", file_path),
        ));
    }

    fs::remove_file(&full_path)
}

/// Safely join paths, preventing directory traversal attacks
fn safe_join(base: &Path, path: &str) -> Result<PathBuf, std::io::Error> {
    let path = path.trim_start_matches('/');

    // Check for directory traversal
    if path.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Directory traversal not allowed",
        ));
    }

    let joined = base.join(path);

    // Verify the resulting path is within base
    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let canonical_joined = joined
        .canonicalize()
        .unwrap_or_else(|_| joined.clone());

    if !canonical_joined.starts_with(&canonical_base) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Path escapes base directory",
        ));
    }

    Ok(joined)
}

/// Check if a path is a valid markdown file
pub fn is_markdown_file(path: &str) -> bool {
    path.ends_with(".md") || path.ends_with(".markdown")
}
