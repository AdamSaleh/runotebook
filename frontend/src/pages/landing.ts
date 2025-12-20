import { logger } from '../logger';
import { apiClient } from '../api';
import { authManager } from '../auth';
import { router } from '../router';
import type { Workspace, Branch } from '../types';

export async function renderLanding(container: HTMLElement): Promise<void> {
  logger.info('Rendering landing page');

  // Check auth first
  if (!authManager.isAuthenticated()) {
    renderLoginForm(container);
    return;
  }

  container.innerHTML = `
    <div class="landing">
      <header class="landing-header">
        <h1>Runotepad</h1>
        <p>Interactive Runbook Editor</p>
      </header>

      <section class="workspaces-section">
        <h2>Workspaces</h2>
        <div id="workspaces-list" class="workspaces-list">
          <p class="loading">Loading workspaces...</p>
        </div>
      </section>

      <section class="create-workspace-section">
        <h2>Add Workspace</h2>
        <form id="create-workspace-form" class="create-form">
          <div class="form-group">
            <label for="ws-name">Name</label>
            <input type="text" id="ws-name" name="name" placeholder="my-runbooks" required />
          </div>
          <div class="form-group">
            <label for="ws-repo">Repository URL</label>
            <input type="text" id="ws-repo" name="repo_url" placeholder="git@github.com:user/repo.git" required />
          </div>
          <div class="form-group">
            <label for="ws-branch">Base Branch</label>
            <input type="text" id="ws-branch" name="base_branch" value="main" required />
          </div>
          <button type="submit" class="btn btn-primary">Clone Repository</button>
        </form>
        <p id="create-error" class="error-message"></p>
      </section>
    </div>
  `;

  // Load workspaces
  await loadWorkspaces();

  // Setup form submission
  const form = document.getElementById('create-workspace-form') as HTMLFormElement;
  form?.addEventListener('submit', handleCreateWorkspace);
}

function renderLoginForm(container: HTMLElement): void {
  container.innerHTML = `
    <div class="landing login-page">
      <header class="landing-header">
        <h1>Runotepad</h1>
        <p>Interactive Runbook Editor</p>
      </header>

      <section class="login-section">
        <h2>Authentication Required</h2>
        <form id="login-form" class="create-form">
          <div class="form-group">
            <label for="token">Access Token</label>
            <input type="password" id="token" name="token" placeholder="Enter your token" required />
          </div>
          <button type="submit" class="btn btn-primary">Login</button>
        </form>
        <p id="login-error" class="error-message"></p>
        <p class="hint">Token is displayed in the server console when starting runotepad.</p>
      </section>
    </div>
  `;

  const form = document.getElementById('login-form') as HTMLFormElement;
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tokenInput = document.getElementById('token') as HTMLInputElement;
    const errorEl = document.getElementById('login-error');

    authManager.setToken(tokenInput.value);

    try {
      const result = await apiClient.checkAuth();
      if (result.valid) {
        router.handleRoute(); // Re-render with auth
      } else {
        if (errorEl) errorEl.textContent = 'Invalid token';
        authManager.clearToken();
      }
    } catch (err) {
      if (errorEl) errorEl.textContent = 'Invalid token';
      authManager.clearToken();
    }
  });
}

async function loadWorkspaces(): Promise<void> {
  const listEl = document.getElementById('workspaces-list');
  if (!listEl) return;

  try {
    const workspaces = await apiClient.listWorkspaces();

    if (workspaces.length === 0) {
      listEl.innerHTML = '<p class="empty">No workspaces yet. Clone a repository to get started.</p>';
      return;
    }

    listEl.innerHTML = workspaces.map(ws => `
      <div class="workspace-card" data-workspace="${ws.name}">
        <div class="workspace-info">
          <h3>${ws.name}</h3>
          <p class="repo-url">${ws.repo_url}</p>
          <p class="base-branch">Base: ${ws.base_branch}</p>
        </div>
        <div class="workspace-actions">
          <button class="btn btn-small btn-secondary show-branches" data-workspace="${ws.name}">
            Branches
          </button>
          <button class="btn btn-small btn-danger delete-workspace" data-workspace="${ws.name}">
            Delete
          </button>
        </div>
        <div class="branches-container" id="branches-${ws.name}" style="display: none;"></div>
      </div>
    `).join('');

    // Add event listeners
    listEl.querySelectorAll('.show-branches').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const workspace = (e.target as HTMLElement).dataset.workspace!;
        toggleBranches(workspace);
      });
    });

    listEl.querySelectorAll('.delete-workspace').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const workspace = (e.target as HTMLElement).dataset.workspace!;
        if (confirm(`Delete workspace "${workspace}"? This cannot be undone.`)) {
          await deleteWorkspace(workspace);
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<p class="error">Failed to load workspaces: ${err}</p>`;
  }
}

async function toggleBranches(workspace: string): Promise<void> {
  const container = document.getElementById(`branches-${workspace}`);
  if (!container) return;

  if (container.style.display !== 'none') {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = '<p class="loading">Loading branches...</p>';

  try {
    const branches = await apiClient.listBranches(workspace);

    container.innerHTML = `
      <div class="branches-list">
        ${branches.map(b => `
          <div class="branch-item ${b.is_worktree ? 'active' : ''}">
            <span class="branch-name">${b.name}</span>
            ${b.is_worktree
              ? `<button class="btn btn-small btn-primary open-branch" data-workspace="${workspace}" data-branch="${b.name}">Open</button>`
              : `<button class="btn btn-small btn-secondary create-worktree" data-workspace="${workspace}" data-branch="${b.name}">Create Worktree</button>`
            }
          </div>
        `).join('')}
      </div>
      <div class="new-branch-form">
        <input type="text" id="new-branch-${workspace}" placeholder="New branch name" />
        <button class="btn btn-small btn-primary create-new-branch" data-workspace="${workspace}">Create Branch</button>
      </div>
    `;

    // Add event listeners
    container.querySelectorAll('.open-branch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const el = e.target as HTMLElement;
        router.navigate(`/${el.dataset.workspace}/${el.dataset.branch}/`);
      });
    });

    container.querySelectorAll('.create-worktree').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const el = e.target as HTMLElement;
        await createWorktree(el.dataset.workspace!, el.dataset.branch!);
      });
    });

    container.querySelectorAll('.create-new-branch').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const el = e.target as HTMLElement;
        const input = document.getElementById(`new-branch-${el.dataset.workspace}`) as HTMLInputElement;
        if (input.value.trim()) {
          await createWorktree(el.dataset.workspace!, input.value.trim());
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<p class="error">Failed to load branches: ${err}</p>`;
  }
}

async function createWorktree(workspace: string, branch: string): Promise<void> {
  try {
    await apiClient.createBranch(workspace, branch);
    await toggleBranches(workspace); // Close
    await toggleBranches(workspace); // Reopen to refresh
    router.navigate(`/${workspace}/${branch}/`);
  } catch (err) {
    alert(`Failed to create worktree: ${err}`);
  }
}

async function deleteWorkspace(workspace: string): Promise<void> {
  try {
    await apiClient.deleteWorkspace(workspace);
    await loadWorkspaces();
  } catch (err) {
    alert(`Failed to delete workspace: ${err}`);
  }
}

async function handleCreateWorkspace(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const errorEl = document.getElementById('create-error');

  const name = (form.querySelector('#ws-name') as HTMLInputElement).value;
  const repoUrl = (form.querySelector('#ws-repo') as HTMLInputElement).value;
  const baseBranch = (form.querySelector('#ws-branch') as HTMLInputElement).value;

  try {
    if (errorEl) errorEl.textContent = '';
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    btn.textContent = 'Cloning...';
    btn.disabled = true;

    await apiClient.createWorkspace(name, repoUrl, baseBranch);
    form.reset();
    await loadWorkspaces();

    btn.textContent = 'Clone Repository';
    btn.disabled = false;
  } catch (err) {
    if (errorEl) errorEl.textContent = `Error: ${err}`;
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    btn.textContent = 'Clone Repository';
    btn.disabled = false;
  }
}
