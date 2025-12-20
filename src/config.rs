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
