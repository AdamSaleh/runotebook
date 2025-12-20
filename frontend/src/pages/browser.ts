import { logger } from '../logger';
import { apiClient } from '../api';
import { router } from '../router';
import type { FileEntry, RouteParams } from '../types';

export async function renderBrowser(
  container: HTMLElement,
  params: RouteParams
): Promise<void> {
  const { workspace, branch } = params;

  if (!workspace || !branch) {
    router.navigate('/');
    return;
  }

  logger.info(`Rendering file browser: ${workspace}/${branch}`);

  container.innerHTML = `
    <div class="browser">
      <header class="browser-header">
        <div class="breadcrumb">
          <a href="/" class="breadcrumb-item">Home</a>
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-item">${workspace}</span>
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-item current">${branch}</span>
        </div>
        <div class="header-actions">
          <button id="back-btn" class="btn btn-secondary">Back</button>
        </div>
      </header>

      <div class="browser-content">
        <div class="create-file-section">
          <h3>Create New File</h3>
          <form id="create-file-form" class="create-file-form">
            <input type="text" id="new-file-path" placeholder="path/to/file.md" required />
            <button type="submit" class="btn btn-primary">Create</button>
          </form>
          <p id="create-file-error" class="error-message"></p>
        </div>

        <h3>Files</h3>
        <nav class="file-tree" id="file-tree">
          <p class="loading">Loading files...</p>
        </nav>
      </div>
    </div>
  `;

  // Setup create file form
  const createForm = document.getElementById('create-file-form') as HTMLFormElement;
  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-file-path') as HTMLInputElement;
    const errorEl = document.getElementById('create-file-error');
    let filePath = input.value.trim();

    // Ensure .md extension
    if (!filePath.endsWith('.md') && !filePath.endsWith('.markdown')) {
      filePath += '.md';
    }

    try {
      if (errorEl) errorEl.textContent = '';
      // Create file with default content
      const defaultContent = `# ${filePath.split('/').pop()?.replace('.md', '') || 'New Document'}\n\nStart writing here...\n`;
      await apiClient.saveFile(workspace!, branch!, filePath, defaultContent);
      // Navigate to the new file
      router.navigate(`/${workspace}/${branch}/${filePath}`);
    } catch (err) {
      if (errorEl) errorEl.textContent = `Error: ${err}`;
    }
  });

  // Setup back button
  document.getElementById('back-btn')?.addEventListener('click', () => {
    router.navigate('/');
  });

  // Setup breadcrumb navigation
  container.querySelector('.breadcrumb a')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigate('/');
  });

  // Load file tree
  await loadFileTree(workspace, branch);
}

async function loadFileTree(workspace: string, branch: string): Promise<void> {
  const treeEl = document.getElementById('file-tree');
  if (!treeEl) return;

  try {
    const files = await apiClient.listFiles(workspace, branch);

    if (files.length === 0) {
      treeEl.innerHTML = `
        <p class="empty">No markdown files found.</p>
        <p class="hint">Create a .md file in the repository to get started.</p>
      `;
      return;
    }

    treeEl.innerHTML = renderFileTree(files, workspace, branch);

    // Add click handlers
    treeEl.querySelectorAll('.file-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const el = e.currentTarget as HTMLElement;
        const path = el.dataset.path;
        if (path) {
          router.navigate(`/${workspace}/${branch}/${path}`);
        }
      });
    });

    treeEl.querySelectorAll('.folder-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const folder = el.closest('.folder-item');
        folder?.classList.toggle('collapsed');
      });
    });
  } catch (err) {
    treeEl.innerHTML = `<p class="error">Failed to load files: ${err}</p>`;
  }
}

function renderFileTree(
  entries: FileEntry[],
  workspace: string,
  branch: string,
  depth = 0
): string {
  return entries.map(entry => {
    if (entry.is_dir) {
      return `
        <div class="folder-item" style="--depth: ${depth}">
          <div class="folder-header">
            <span class="folder-toggle">▼</span>
            <span class="folder-name">${entry.name}</span>
          </div>
          <div class="folder-children">
            ${entry.children ? renderFileTree(entry.children, workspace, branch, depth + 1) : ''}
          </div>
        </div>
      `;
    } else {
      return `
        <div class="file-item" style="--depth: ${depth}" data-path="${entry.path}">
          <span class="file-icon">📄</span>
          <span class="file-name">${entry.name}</span>
        </div>
      `;
    }
  }).join('');
}
