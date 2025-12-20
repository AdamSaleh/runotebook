import { logger } from '../logger';
import { apiClient } from '../api';
import { router } from '../router';
import { createEditor, getEditorContent, setEditorContent } from '../editor';
import { wsConnection } from '../websocket';
import { terminalManager } from '../terminal';
import type { RouteParams } from '../types';

let currentWorkspace = '';
let currentBranch = '';
let currentFilepath = '';
let hasUnsavedChanges = false;

export async function renderEditor(
  container: HTMLElement,
  params: RouteParams
): Promise<void> {
  const { workspace, branch, filepath } = params;

  if (!workspace || !branch || !filepath) {
    router.navigate('/');
    return;
  }

  currentWorkspace = workspace;
  currentBranch = branch;
  currentFilepath = filepath;

  logger.info(`Rendering editor: ${workspace}/${branch}/${filepath}`);

  container.innerHTML = `
    <div class="editor-page">
      <header class="editor-header">
        <div class="breadcrumb">
          <a href="/" class="breadcrumb-link">Home</a>
          <span class="breadcrumb-sep">/</span>
          <a href="/${workspace}/${branch}/" class="breadcrumb-link">${workspace}/${branch}</a>
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-current">${filepath}</span>
        </div>
        <div class="git-toolbar">
          <button id="save-btn" class="btn btn-primary" title="Save (Ctrl+S)">Save</button>
          <button id="commit-btn" class="btn btn-secondary" title="Commit changes">Commit</button>
          <button id="push-btn" class="btn btn-secondary" title="Push to remote">Push</button>
          <button id="pull-btn" class="btn btn-secondary" title="Pull from remote">Pull</button>
          <button id="rebase-btn" class="btn btn-secondary" title="Rebase on base branch">Rebase</button>
        </div>
      </header>

      <div class="tabs">
        <button class="tab active" data-view="editor">Editor</button>
        <button class="tab" data-view="split">Split</button>
        <button class="tab" data-view="sessions">Sessions</button>
        <button id="clearSessions" class="clear-sessions">Clear All</button>
      </div>

      <div id="container" class="container editor">
        <div class="editor-pane">
          <div id="editor"></div>
        </div>
        <div class="sessions-pane">
          <h2>Terminal Sessions</h2>
          <div id="sessions"></div>
        </div>
      </div>

      <div id="status-bar" class="status-bar">
        <span id="save-status"></span>
      </div>
    </div>
  `;

  // Setup navigation
  setupNavigation();

  // Setup tabs
  setupTabs();

  // Setup git toolbar
  setupGitToolbar();

  // Setup clear sessions
  setupClearSessions();

  // Connect WebSocket
  wsConnection.connect();

  // Load file content
  await loadFile();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();
}

function setupNavigation(): void {
  document.querySelectorAll('.breadcrumb-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const href = (e.target as HTMLAnchorElement).getAttribute('href');
      if (href) {
        router.navigate(href);
      }
    });
  });
}

function setupTabs(): void {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      const container = document.getElementById('container');
      if (container) {
        const view = (tab as HTMLElement).dataset.view || 'editor';
        container.className = `container ${view}`;
      }
    });
  });
}

function setupGitToolbar(): void {
  document.getElementById('save-btn')?.addEventListener('click', saveFile);
  document.getElementById('commit-btn')?.addEventListener('click', commitFile);
  document.getElementById('push-btn')?.addEventListener('click', pushBranch);
  document.getElementById('pull-btn')?.addEventListener('click', pullBranch);
  document.getElementById('rebase-btn')?.addEventListener('click', rebaseBranch);
}

function setupClearSessions(): void {
  document.getElementById('clearSessions')?.addEventListener('click', () => {
    logger.info('Clearing all sessions');
    terminalManager.closeAllSessions();
  });
}

function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
  });
}

async function loadFile(): Promise<void> {
  const editorEl = document.getElementById('editor');
  if (!editorEl) return;

  try {
    const { content } = await apiClient.readFile(currentWorkspace, currentBranch, currentFilepath);
    createEditor(editorEl, content);
    hasUnsavedChanges = false;
    updateStatus('File loaded');

    // Track changes
    editorEl.addEventListener('input', () => {
      hasUnsavedChanges = true;
      updateStatus('Unsaved changes');
    });
  } catch (err) {
    editorEl.innerHTML = `<p class="error">Failed to load file: ${err}</p>`;
  }
}

async function saveFile(): Promise<void> {
  const content = getEditorContent();
  if (!content) return;

  updateStatus('Saving...');
  try {
    await apiClient.saveFile(currentWorkspace, currentBranch, currentFilepath, content);
    hasUnsavedChanges = false;
    updateStatus('Saved');
  } catch (err) {
    updateStatus(`Save failed: ${err}`);
  }
}

async function commitFile(): Promise<void> {
  const message = prompt('Commit message:');
  if (!message) return;

  updateStatus('Committing...');
  try {
    // Save first if there are unsaved changes
    if (hasUnsavedChanges) {
      await saveFile();
    }

    const result = await apiClient.commit(
      currentWorkspace,
      currentBranch,
      message,
      [currentFilepath]
    );
    updateStatus(`Committed: ${result.commit_id.slice(0, 7)}`);
  } catch (err) {
    updateStatus(`Commit failed: ${err}`);
  }
}

async function pushBranch(): Promise<void> {
  updateStatus('Pushing...');
  try {
    await apiClient.push(currentWorkspace, currentBranch);
    updateStatus('Pushed');
  } catch (err) {
    updateStatus(`Push failed: ${err}`);
  }
}

async function pullBranch(): Promise<void> {
  updateStatus('Pulling...');
  try {
    await apiClient.pull(currentWorkspace, currentBranch);
    updateStatus('Pulled');
    // Reload file content
    await loadFile();
  } catch (err) {
    updateStatus(`Pull failed: ${err}`);
  }
}

async function rebaseBranch(): Promise<void> {
  if (!confirm('Rebase on base branch? This may require resolving conflicts.')) {
    return;
  }

  updateStatus('Rebasing...');
  try {
    await apiClient.rebase(currentWorkspace, currentBranch);
    updateStatus('Rebased');
    // Reload file content
    await loadFile();
  } catch (err) {
    updateStatus(`Rebase failed: ${err}`);
  }
}

function updateStatus(message: string): void {
  const statusEl = document.getElementById('save-status');
  if (statusEl) {
    statusEl.textContent = message;
    // Clear after 3 seconds for success messages
    if (!message.includes('failed') && !message.includes('Unsaved')) {
      setTimeout(() => {
        if (statusEl.textContent === message) {
          statusEl.textContent = '';
        }
      }, 3000);
    }
  }
}
