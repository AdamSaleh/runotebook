use std::path::Path;
use std::process::Command;

/// Result type for git operations
pub type GitResult<T> = Result<T, String>;

/// Run a git command and return stdout
fn run_git(args: &[&str], cwd: &Path) -> GitResult<String> {
    log::debug!("Running git {:?} in {:?}", args, cwd);

    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Git command failed: {}", stderr))
    }
}

/// Clone a repository as a bare clone
pub fn clone_repo(url: &str, path: &Path) -> GitResult<()> {
    log::info!("Cloning repository {} to {:?}", url, path);

    let output = Command::new("git")
        .args(["clone", "--bare", url])
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if output.status.success() {
        log::info!("Clone completed successfully");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Git clone failed: {}", stderr))
    }
}

/// Create a worktree from the bare repository
pub fn create_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch_name: &str,
    from_branch: Option<&str>,
) -> GitResult<()> {
    log::info!(
        "Creating worktree at {:?} for branch {}",
        worktree_path,
        branch_name
    );

    // Check if branch exists
    let branches_output = run_git(&["branch", "--list", branch_name], repo_path)?;
    let branch_exists = !branches_output.trim().is_empty();

    if branch_exists {
        // Create worktree for existing branch
        let output = Command::new("git")
            .args(["worktree", "add"])
            .arg(worktree_path)
            .arg(branch_name)
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Git worktree add failed: {}", stderr));
        }
    } else {
        // Create new branch from source
        let source = from_branch.unwrap_or("HEAD");
        let output = Command::new("git")
            .args(["worktree", "add", "-b", branch_name])
            .arg(worktree_path)
            .arg(source)
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Git worktree add failed: {}", stderr));
        }
    }

    log::info!("Worktree created successfully");
    Ok(())
}

/// List all worktrees for a repository
pub fn list_worktrees(repo_path: &Path) -> GitResult<Vec<String>> {
    let output = run_git(&["worktree", "list", "--porcelain"], repo_path)?;

    let worktrees: Vec<String> = output
        .lines()
        .filter_map(|line| {
            if let Some(path) = line.strip_prefix("worktree ") {
                Some(
                    Path::new(path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                )
            } else {
                None
            }
        })
        .filter(|s| !s.is_empty())
        .collect();

    Ok(worktrees)
}

/// Remove a worktree
pub fn remove_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    _worktree_name: &str,
) -> GitResult<()> {
    log::info!("Removing worktree: {:?}", worktree_path);

    // Remove worktree
    let output = Command::new("git")
        .args(["worktree", "remove", "--force"])
        .arg(worktree_path)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

    if !output.status.success() {
        // If git worktree remove fails, try manual removal
        if worktree_path.exists() {
            std::fs::remove_dir_all(worktree_path)
                .map_err(|e| format!("Failed to remove worktree directory: {}", e))?;
        }

        // Prune worktrees
        let _ = run_git(&["worktree", "prune"], repo_path);
    }

    Ok(())
}

/// List all branches in a repository
pub fn list_branches(repo_path: &Path) -> GitResult<Vec<String>> {
    let output = run_git(&["branch", "--format=%(refname:short)"], repo_path)?;

    let branches: Vec<String> = output
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(branches)
}

/// Stage and commit files in a worktree
pub fn commit_files(
    worktree_path: &Path,
    files: &[String],
    message: &str,
) -> GitResult<String> {
    log::info!("Committing {} files in {:?}", files.len(), worktree_path);

    // Stage files
    for file in files {
        run_git(&["add", file], worktree_path)?;
    }

    // Commit
    let output = run_git(&["commit", "-m", message], worktree_path)?;

    // Get commit hash
    let hash = run_git(&["rev-parse", "HEAD"], worktree_path)?;

    log::info!("Created commit: {}", hash.trim());
    Ok(hash.trim().to_string())
}

/// Push the current branch to origin
pub fn push_branch(worktree_path: &Path) -> GitResult<()> {
    log::info!("Pushing branch from {:?}", worktree_path);

    run_git(&["push", "-u", "origin", "HEAD"], worktree_path)?;

    log::info!("Push completed successfully");
    Ok(())
}

/// Fetch updates from origin
pub fn fetch_origin(repo_path: &Path) -> GitResult<()> {
    log::info!("Fetching from origin for {:?}", repo_path);

    run_git(&["fetch", "--all"], repo_path)?;

    log::info!("Fetch completed successfully");
    Ok(())
}

/// Pull updates for a specific branch (fetch + merge)
pub fn pull_branch(
    repo_path: &Path,
    worktree_path: &Path,
    _branch_name: &str,
) -> GitResult<()> {
    log::info!("Pulling updates in {:?}", worktree_path);

    // Fetch in bare repo first
    fetch_origin(repo_path)?;

    // Pull in worktree
    run_git(&["pull", "--ff-only"], worktree_path)?;

    log::info!("Pull completed successfully");
    Ok(())
}

/// Rebase current branch on top of base branch
pub fn rebase_on_base(
    worktree_path: &Path,
    base_branch: &str,
) -> GitResult<()> {
    log::info!(
        "Rebasing {:?} on top of {}",
        worktree_path,
        base_branch
    );

    // Fetch latest first
    run_git(&["fetch", "origin", base_branch], worktree_path)?;

    // Rebase
    run_git(&["rebase", &format!("origin/{}", base_branch)], worktree_path)?;

    log::info!("Rebase completed successfully");
    Ok(())
}

/// Rename a branch
pub fn rename_branch(
    worktree_path: &Path,
    new_name: &str,
) -> GitResult<()> {
    log::info!("Renaming branch to {} in {:?}", new_name, worktree_path);

    run_git(&["branch", "-m", new_name], worktree_path)?;

    log::info!("Branch renamed successfully");
    Ok(())
}

/// Get the current branch name of a worktree
pub fn get_current_branch(worktree_path: &Path) -> GitResult<String> {
    let output = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], worktree_path)?;
    Ok(output.trim().to_string())
}

/// Check if there are uncommitted changes
pub fn has_uncommitted_changes(worktree_path: &Path) -> GitResult<bool> {
    let output = run_git(&["status", "--porcelain"], worktree_path)?;
    Ok(!output.trim().is_empty())
}

/// Get git status
pub fn get_status(worktree_path: &Path) -> GitResult<String> {
    run_git(&["status", "--short"], worktree_path)
}
