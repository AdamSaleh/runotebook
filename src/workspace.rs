use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth;
use crate::config::{sanitize_branch_name, ConfigManager};
use crate::file_ops::{self, FileEntry};
use crate::git_ops;

// Request/Response types

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub repo_url: String,
    pub base_branch: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBranchRequest {
    pub branch_name: String,
    pub from_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveFileRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct FileQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct ChangeBaseBranchRequest {
    pub new_base_branch: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameBranchRequest {
    pub new_name: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub repo_url: String,
    pub base_branch: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_worktree: bool,
    pub worktree_path: Option<String>,
}

// API Handlers

/// GET /api/workspaces - List all workspaces
pub async fn list_workspaces(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let workspaces: Vec<WorkspaceInfo> = config
        .get_workspaces()
        .into_iter()
        .map(|(name, ws)| WorkspaceInfo {
            name,
            repo_url: ws.repo_url,
            base_branch: ws.base_branch,
            created_at: ws.created_at.to_rfc3339(),
        })
        .collect();

    HttpResponse::Ok().json(workspaces)
}

/// POST /api/workspaces - Create a new workspace (clone repo)
pub async fn create_workspace(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    body: web::Json<CreateWorkspaceRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let name = &body.name;
    let repo_url = &body.repo_url;
    let base_branch = &body.base_branch;

    // Check if workspace already exists
    if config.get_workspace(name).is_some() {
        return HttpResponse::Conflict().json(serde_json::json!({
            "error": format!("Workspace '{}' already exists", name)
        }));
    }

    // Create workspace directory
    let workspace_path = config.workspace_path(name);
    let repo_path = config.repo_path(name);
    let worktrees_path = config.worktrees_path(name);

    if let Err(e) = std::fs::create_dir_all(&workspace_path) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to create workspace directory: {}", e)
        }));
    }

    if let Err(e) = std::fs::create_dir_all(&worktrees_path) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to create worktrees directory: {}", e)
        }));
    }

    // Clone repository
    if let Err(e) = git_ops::clone_repo(repo_url, &repo_path) {
        // Cleanup on failure
        let _ = std::fs::remove_dir_all(&workspace_path);
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to clone repository: {}", e)
        }));
    }

    // Save workspace config
    if let Err(e) = config.add_workspace(name.clone(), repo_url.clone(), base_branch.clone()) {
        // Cleanup on failure
        let _ = std::fs::remove_dir_all(&workspace_path);
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to save workspace config: {}", e)
        }));
    }

    HttpResponse::Created().json(serde_json::json!({
        "name": name,
        "repo_url": repo_url,
        "base_branch": base_branch,
        "message": "Workspace created successfully"
    }))
}

/// DELETE /api/workspaces/{name} - Delete a workspace
pub async fn delete_workspace(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<String>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let name = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&name).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", name)
        }));
    }

    // Remove workspace directory
    let workspace_path = config.workspace_path(&name);
    if let Err(e) = std::fs::remove_dir_all(&workspace_path) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to remove workspace directory: {}", e)
        }));
    }

    // Remove from config
    if let Err(e) = config.remove_workspace(&name) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to remove workspace from config: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": format!("Workspace '{}' deleted", name)
    }))
}

/// GET /api/workspaces/{name}/branches - List branches/worktrees
pub async fn list_branches(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<String>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let workspace = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let repo_path = config.repo_path(&workspace);
    let worktrees_path = config.worktrees_path(&workspace);

    // Get all branches from repo
    let branches = match git_ops::list_branches(&repo_path) {
        Ok(b) => b,
        Err(e) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("Failed to list branches: {}", e)
            }));
        }
    };

    // Get active worktrees
    let worktrees = git_ops::list_worktrees(&repo_path).unwrap_or_default();

    let result: Vec<BranchInfo> = branches
        .into_iter()
        .map(|name| {
            let sanitized = sanitize_branch_name(&name);
            let is_worktree = worktrees.contains(&sanitized);
            let worktree_path = if is_worktree {
                Some(worktrees_path.join(&sanitized).to_string_lossy().to_string())
            } else {
                None
            };

            BranchInfo {
                name,
                is_worktree,
                worktree_path,
            }
        })
        .collect();

    HttpResponse::Ok().json(result)
}

/// POST /api/workspaces/{name}/branches - Create a new worktree
pub async fn create_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<String>,
    body: web::Json<CreateBranchRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let workspace = path.into_inner();

    // Check if workspace exists
    let ws_config = match config.get_workspace(&workspace) {
        Some(c) => c,
        None => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": format!("Workspace '{}' not found", workspace)
            }));
        }
    };

    let repo_path = config.repo_path(&workspace);
    let branch_name = &body.branch_name;
    let from_branch = body.from_branch.as_deref().or(Some(&ws_config.base_branch));
    let worktree_path = config.worktree_path(&workspace, branch_name);

    // Create worktree
    if let Err(e) = git_ops::create_worktree(&repo_path, &worktree_path, branch_name, from_branch) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to create worktree: {}", e)
        }));
    }

    HttpResponse::Created().json(serde_json::json!({
        "branch": branch_name,
        "worktree_path": worktree_path.to_string_lossy(),
        "message": "Worktree created successfully"
    }))
}

/// DELETE /api/workspaces/{name}/branches/{branch} - Delete a worktree
pub async fn delete_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let repo_path = config.repo_path(&workspace);
    let worktree_path = config.worktree_path(&workspace, &branch);
    let worktree_name = sanitize_branch_name(&branch);

    if let Err(e) = git_ops::remove_worktree(&repo_path, &worktree_path, &worktree_name) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to remove worktree: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": format!("Worktree '{}' deleted", branch)
    }))
}

/// GET /api/workspaces/{name}/branches/{branch}/files - List files
pub async fn list_files(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found. Create it first.", branch)
        }));
    }

    let files: Vec<FileEntry> = match file_ops::list_files(&worktree_path, None) {
        Ok(f) => f,
        Err(e) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("Failed to list files: {}", e)
            }));
        }
    };

    HttpResponse::Ok().json(files)
}

/// GET /api/workspaces/{name}/branches/{branch}/file?path=x - Read file
pub async fn read_file(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
    query: web::Query<FileQuery>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();
    let file_path = &query.path;

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    match file_ops::read_file(&worktree_path, file_path) {
        Ok(content) => HttpResponse::Ok().json(serde_json::json!({
            "path": file_path,
            "content": content
        })),
        Err(e) => HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Failed to read file: {}", e)
        })),
    }
}

/// PUT /api/workspaces/{name}/branches/{branch}/file?path=x - Save file
pub async fn save_file(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
    query: web::Query<FileQuery>,
    body: web::Json<SaveFileRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();
    let file_path = &query.path;

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    if let Err(e) = file_ops::write_file(&worktree_path, file_path, &body.content) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to save file: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": "File saved successfully",
        "path": file_path
    }))
}

/// POST /api/workspaces/{name}/branches/{branch}/commit - Commit files
pub async fn commit_files(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
    body: web::Json<CommitRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    match git_ops::commit_files(&worktree_path, &body.files, &body.message) {
        Ok(commit_id) => HttpResponse::Ok().json(serde_json::json!({
            "message": "Commit created successfully",
            "commit_id": commit_id
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to commit: {}", e)
        })),
    }
}

/// POST /api/workspaces/{name}/branches/{branch}/push - Push branch
pub async fn push_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    if let Err(e) = git_ops::push_branch(&worktree_path) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to push: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": "Push completed successfully"
    }))
}

/// POST /api/workspaces/{name}/branches/{branch}/pull - Pull updates
pub async fn pull_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    let ws_config = match config.get_workspace(&workspace) {
        Some(c) => c,
        None => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": format!("Workspace '{}' not found", workspace)
            }));
        }
    };

    let repo_path = config.repo_path(&workspace);
    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    if let Err(e) = git_ops::pull_branch(&repo_path, &worktree_path, &ws_config.base_branch) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to pull: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": "Pull completed successfully"
    }))
}

/// POST /api/workspaces/{name}/branches/{branch}/rebase - Rebase on base branch
pub async fn rebase_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    let ws_config = match config.get_workspace(&workspace) {
        Some(c) => c,
        None => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": format!("Workspace '{}' not found", workspace)
            }));
        }
    };

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    if let Err(e) = git_ops::rebase_on_base(&worktree_path, &ws_config.base_branch) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to rebase: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": format!("Rebase on '{}' completed successfully", ws_config.base_branch)
    }))
}

/// POST /api/workspaces/{name}/branches/{branch}/checkout - Change base branch
pub async fn change_base_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
    body: web::Json<ChangeBaseBranchRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, _branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    if let Err(e) = config.update_workspace_base_branch(&workspace, body.new_base_branch.clone()) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to update base branch: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": format!("Base branch changed to '{}'", body.new_base_branch)
    }))
}

/// POST /api/workspaces/{name}/branches/{branch}/rename - Rename branch
pub async fn rename_branch(
    req: HttpRequest,
    config: web::Data<Arc<ConfigManager>>,
    path: web::Path<(String, String)>,
    body: web::Json<RenameBranchRequest>,
) -> HttpResponse {
    if let Err(resp) = auth::check_auth(&req, &config) {
        return resp;
    }

    let (workspace, branch) = path.into_inner();

    // Check if workspace exists
    if config.get_workspace(&workspace).is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Workspace '{}' not found", workspace)
        }));
    }

    let worktree_path = config.worktree_path(&workspace, &branch);

    if !worktree_path.exists() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Worktree '{}' not found", branch)
        }));
    }

    if let Err(e) = git_ops::rename_branch(&worktree_path, &body.new_name) {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("Failed to rename branch: {}", e)
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "message": format!("Branch renamed to '{}'", body.new_name)
    }))
}
