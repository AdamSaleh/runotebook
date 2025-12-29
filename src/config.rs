use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub repo_url: String,
    pub base_branch: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub token: String,
    #[serde(default)]
    pub workspaces: HashMap<String, WorkspaceConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            token: generate_token(),
            workspaces: HashMap::new(),
        }
    }
}

pub struct ConfigManager {
    config: RwLock<Config>,
    config_path: PathBuf,
    workspace_dir: PathBuf,
}

impl ConfigManager {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = get_config_path();
        let workspace_dir = get_workspace_dir();

        // Ensure directories exist
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir_all(&workspace_dir)?;

        // Load or create config
        let config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)?;
            serde_json::from_str(&content)?
        } else {
            let config = Config::default();
            let content = serde_json::to_string_pretty(&config)?;
            fs::write(&config_path, content)?;
            log::info!("Created new config file at {:?}", config_path);
            log::info!("Access token: {}", config.token);
            config
        };

        Ok(Self {
            config: RwLock::new(config),
            config_path,
            workspace_dir,
        })
    }

    pub fn get_token(&self) -> String {
        self.config.read().unwrap().token.clone()
    }

    pub fn verify_token(&self, token: &str) -> bool {
        self.config.read().unwrap().token == token
    }

    pub fn get_workspace_dir(&self) -> &PathBuf {
        &self.workspace_dir
    }

    pub fn get_workspaces(&self) -> HashMap<String, WorkspaceConfig> {
        self.config.read().unwrap().workspaces.clone()
    }

    pub fn get_workspace(&self, name: &str) -> Option<WorkspaceConfig> {
        self.config.read().unwrap().workspaces.get(name).cloned()
    }

    pub fn add_workspace(
        &self,
        name: String,
        repo_url: String,
        base_branch: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        {
            let mut config = self.config.write().unwrap();
            config.workspaces.insert(
                name,
                WorkspaceConfig {
                    repo_url,
                    base_branch,
                    created_at: Utc::now(),
                },
            );
        }
        self.save()
    }

    pub fn remove_workspace(&self, name: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let removed = {
            let mut config = self.config.write().unwrap();
            config.workspaces.remove(name).is_some()
        };
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    pub fn update_workspace_base_branch(
        &self,
        name: &str,
        base_branch: String,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let updated = {
            let mut config = self.config.write().unwrap();
            if let Some(workspace) = config.workspaces.get_mut(name) {
                workspace.base_branch = base_branch;
                true
            } else {
                false
            }
        };
        if updated {
            self.save()?;
        }
        Ok(updated)
    }

    fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let config = self.config.read().unwrap();
        let content = serde_json::to_string_pretty(&*config)?;
        fs::write(&self.config_path, content)?;
        Ok(())
    }

    pub fn workspace_path(&self, name: &str) -> PathBuf {
        self.workspace_dir.join(name)
    }

    pub fn repo_path(&self, workspace: &str) -> PathBuf {
        self.workspace_path(workspace).join("repo")
    }

    pub fn worktrees_path(&self, workspace: &str) -> PathBuf {
        self.workspace_path(workspace).join("worktrees")
    }

    pub fn worktree_path(&self, workspace: &str, branch: &str) -> PathBuf {
        self.worktrees_path(workspace).join(sanitize_branch_name(branch))
    }
}

fn get_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("RUNOTEPAD_CONFIG_FILE") {
        return PathBuf::from(path);
    }

    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".runotepad")
        .join("config.json")
}

fn get_workspace_dir() -> PathBuf {
    if let Ok(path) = std::env::var("RUNOTEPAD_WORKSPACE_DIR") {
        return PathBuf::from(path);
    }

    PathBuf::from("/tmp/runbookws")
}

fn generate_token() -> String {
    // Check environment variable first
    if let Ok(token) = std::env::var("RUNOTEPAD_TOKEN") {
        return token;
    }

    // Generate a random 32-character hex token
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Sanitize branch name for use as directory name
pub fn sanitize_branch_name(name: &str) -> String {
    name.replace('/', "_").replace('\\', "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    #[test]
    #[serial]
    fn test_sanitize_branch_name() {
        assert_eq!(sanitize_branch_name("main"), "main");
        assert_eq!(sanitize_branch_name("feature/test"), "feature_test");
        assert_eq!(sanitize_branch_name("fix\\bug"), "fix_bug");
        assert_eq!(sanitize_branch_name("feature/user/login"), "feature_user_login");
    }

    #[test]
    #[serial]
    #[serial]
    fn test_generate_token() {
        // Clear env var in case it was set by another test
        std::env::remove_var("RUNOTEPAD_TOKEN");

        let token = generate_token();
        assert_eq!(token.len(), 32); // 16 bytes as hex = 32 chars
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    #[serial]
    #[serial]
    fn test_generate_token_from_env() {
        std::env::set_var("RUNOTEPAD_TOKEN", "test_token_123");
        let token = generate_token();
        assert_eq!(token, "test_token_123");
        std::env::remove_var("RUNOTEPAD_TOKEN");
    }

    #[test]
    #[serial]
    fn test_config_default() {
        let config = Config::default();
        assert!(!config.token.is_empty());
        assert!(config.workspaces.is_empty());
    }

    #[test]
    #[serial]
    #[serial]
    fn test_config_manager_new() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let workspace_dir = temp_dir.path().join("workspaces");

        std::env::set_var("RUNOTEPAD_CONFIG_FILE", config_path.to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", workspace_dir.to_str().unwrap());

        let manager = ConfigManager::new().unwrap();

        // Config file should be created
        assert!(config_path.exists());

        // Workspace dir should be created
        assert!(workspace_dir.exists());

        // Token should be set
        assert!(!manager.get_token().is_empty());

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }

    #[test]
    #[serial]
    #[serial]
    fn test_verify_token() {
        let temp_dir = TempDir::new().unwrap();
        std::env::set_var("RUNOTEPAD_CONFIG_FILE", temp_dir.path().join("config.json").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().join("ws").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_TOKEN", "test_token");

        let manager = ConfigManager::new().unwrap();

        assert!(manager.verify_token("test_token"));
        assert!(!manager.verify_token("wrong_token"));

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
        std::env::remove_var("RUNOTEPAD_TOKEN");
    }

    #[test]
    #[serial]
    fn test_add_and_get_workspace() {
        let temp_dir = TempDir::new().unwrap();
        std::env::set_var("RUNOTEPAD_CONFIG_FILE", temp_dir.path().join("config.json").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().join("ws").to_str().unwrap());

        let manager = ConfigManager::new().unwrap();

        manager.add_workspace(
            "test-workspace".to_string(),
            "https://github.com/test/repo.git".to_string(),
            "main".to_string(),
        ).unwrap();

        let workspace = manager.get_workspace("test-workspace").unwrap();
        assert_eq!(workspace.repo_url, "https://github.com/test/repo.git");
        assert_eq!(workspace.base_branch, "main");

        let workspaces = manager.get_workspaces();
        assert_eq!(workspaces.len(), 1);

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }

    #[test]
    #[serial]
    fn test_remove_workspace() {
        let temp_dir = TempDir::new().unwrap();
        std::env::set_var("RUNOTEPAD_CONFIG_FILE", temp_dir.path().join("config.json").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().join("ws").to_str().unwrap());

        let manager = ConfigManager::new().unwrap();

        manager.add_workspace(
            "test-workspace".to_string(),
            "https://github.com/test/repo.git".to_string(),
            "main".to_string(),
        ).unwrap();

        assert!(manager.get_workspace("test-workspace").is_some());

        let removed = manager.remove_workspace("test-workspace").unwrap();
        assert!(removed);

        assert!(manager.get_workspace("test-workspace").is_none());

        // Removing again should return false
        let removed = manager.remove_workspace("test-workspace").unwrap();
        assert!(!removed);

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }

    #[test]
    #[serial]
    fn test_update_workspace_base_branch() {
        let temp_dir = TempDir::new().unwrap();
        std::env::set_var("RUNOTEPAD_CONFIG_FILE", temp_dir.path().join("config.json").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().join("ws").to_str().unwrap());

        let manager = ConfigManager::new().unwrap();

        manager.add_workspace(
            "test-workspace".to_string(),
            "https://github.com/test/repo.git".to_string(),
            "main".to_string(),
        ).unwrap();

        let updated = manager.update_workspace_base_branch("test-workspace", "develop".to_string()).unwrap();
        assert!(updated);

        let workspace = manager.get_workspace("test-workspace").unwrap();
        assert_eq!(workspace.base_branch, "develop");

        // Update non-existent workspace
        let updated = manager.update_workspace_base_branch("nonexistent", "main".to_string()).unwrap();
        assert!(!updated);

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }

    #[test]
    #[serial]
    fn test_workspace_paths() {
        let temp_dir = TempDir::new().unwrap();
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().to_str().unwrap());

        let manager = ConfigManager::new().unwrap();

        assert_eq!(
            manager.workspace_path("test"),
            temp_dir.path().join("test")
        );

        assert_eq!(
            manager.repo_path("test"),
            temp_dir.path().join("test").join("repo")
        );

        assert_eq!(
            manager.worktrees_path("test"),
            temp_dir.path().join("test").join("worktrees")
        );

        assert_eq!(
            manager.worktree_path("test", "feature/branch"),
            temp_dir.path().join("test").join("worktrees").join("feature_branch")
        );

        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }

    #[test]
    #[serial]
    fn test_config_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");

        // Set env vars BEFORE creating any manager
        std::env::set_var("RUNOTEPAD_CONFIG_FILE", config_path.to_str().unwrap());
        std::env::set_var("RUNOTEPAD_WORKSPACE_DIR", temp_dir.path().join("ws").to_str().unwrap());
        std::env::set_var("RUNOTEPAD_TOKEN", "persistent_token");

        // Create manager and add workspace
        {
            let manager = ConfigManager::new().unwrap();
            assert_eq!(manager.get_token(), "persistent_token");
            manager.add_workspace(
                "persistent".to_string(),
                "https://example.com/repo.git".to_string(),
                "main".to_string(),
            ).unwrap();
        }

        // Remove token env var to test loading from file
        std::env::remove_var("RUNOTEPAD_TOKEN");

        // Create new manager instance - should load from file
        {
            let manager = ConfigManager::new().unwrap();
            assert_eq!(manager.get_token(), "persistent_token");
            let workspace = manager.get_workspace("persistent").unwrap();
            assert_eq!(workspace.repo_url, "https://example.com/repo.git");
        }

        std::env::remove_var("RUNOTEPAD_CONFIG_FILE");
        std::env::remove_var("RUNOTEPAD_WORKSPACE_DIR");
    }
}
