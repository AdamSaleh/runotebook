import { logger } from './logger';
import { authManager } from './auth';
import type { Workspace, Branch, FileEntry } from './types';

/**
 * Resolve a relative file path against a base path (markdown file location)
 * e.g., resolveFilePath('docs/runbook.md', './src/utils.js') => 'docs/src/utils.js'
 * e.g., resolveFilePath('docs/runbook.md', '../lib/utils.js') => 'lib/utils.js'
 */
export function resolveFilePath(markdownPath: string, relativePath: string): string {
  // Get the directory containing the markdown file
  const lastSlash = markdownPath.lastIndexOf('/');
  const baseDir = lastSlash >= 0 ? markdownPath.substring(0, lastSlash) : '';

  // Combine base directory with relative path
  const combined = baseDir ? `${baseDir}/${relativePath}` : relativePath;

  // Normalize the path (resolve . and ..)
  const parts = combined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    } else if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}

class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${window.location.protocol}//${window.location.host}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authManager.getAuthHeader(),
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    logger.debug(`API ${method} ${path}`);
    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      logger.error(`API error: ${error.error || response.statusText}`);
      throw new Error(error.error || response.statusText);
    }

    return response.json();
  }

  // Auth
  async checkAuth(): Promise<{ valid: boolean }> {
    return this.request('GET', '/api/auth/check');
  }

  // Workspaces
  async listWorkspaces(): Promise<Workspace[]> {
    return this.request('GET', '/api/workspaces');
  }

  async createWorkspace(
    name: string,
    repoUrl: string,
    baseBranch: string
  ): Promise<Workspace> {
    return this.request('POST', '/api/workspaces', {
      name,
      repo_url: repoUrl,
      base_branch: baseBranch,
    });
  }

  async deleteWorkspace(name: string): Promise<void> {
    return this.request('DELETE', `/api/workspaces/${encodeURIComponent(name)}`);
  }

  // Branches
  async listBranches(workspace: string): Promise<Branch[]> {
    return this.request('GET', `/api/workspaces/${encodeURIComponent(workspace)}/branches`);
  }

  async createBranch(
    workspace: string,
    branchName: string,
    fromBranch?: string
  ): Promise<void> {
    return this.request('POST', `/api/workspaces/${encodeURIComponent(workspace)}/branches`, {
      branch_name: branchName,
      from_branch: fromBranch,
    });
  }

  async deleteBranch(workspace: string, branch: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}`
    );
  }

  // Files
  async listFiles(workspace: string, branch: string): Promise<FileEntry[]> {
    return this.request(
      'GET',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/files`
    );
  }

  async readFile(
    workspace: string,
    branch: string,
    path: string
  ): Promise<{ path: string; content: string }> {
    return this.request(
      'GET',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/file?path=${encodeURIComponent(path)}`
    );
  }

  async saveFile(
    workspace: string,
    branch: string,
    path: string,
    content: string
  ): Promise<void> {
    return this.request(
      'PUT',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/file?path=${encodeURIComponent(path)}`,
      { content }
    );
  }

  /**
   * Read an embedded file relative to a markdown file
   */
  async readEmbeddedFile(
    workspace: string,
    branch: string,
    markdownPath: string,
    relativePath: string
  ): Promise<{ path: string; content: string; exists: true } | { path: string; exists: false }> {
    const resolvedPath = resolveFilePath(markdownPath, relativePath);
    try {
      const result = await this.readFile(workspace, branch, resolvedPath);
      return { ...result, exists: true as const };
    } catch {
      return { path: resolvedPath, exists: false as const };
    }
  }

  /**
   * Save an embedded file relative to a markdown file
   */
  async saveEmbeddedFile(
    workspace: string,
    branch: string,
    markdownPath: string,
    relativePath: string,
    content: string
  ): Promise<void> {
    const resolvedPath = resolveFilePath(markdownPath, relativePath);
    return this.saveFile(workspace, branch, resolvedPath, content);
  }

  // Git operations
  async commit(
    workspace: string,
    branch: string,
    message: string,
    files: string[]
  ): Promise<{ commit_id: string }> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/commit`,
      { message, files }
    );
  }

  async push(workspace: string, branch: string): Promise<void> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/push`
    );
  }

  async pull(workspace: string, branch: string): Promise<void> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/pull`
    );
  }

  async rebase(workspace: string, branch: string): Promise<void> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/rebase`
    );
  }

  async changeBaseBranch(
    workspace: string,
    branch: string,
    newBaseBranch: string
  ): Promise<void> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/checkout`,
      { new_base_branch: newBaseBranch }
    );
  }

  async renameBranch(
    workspace: string,
    branch: string,
    newName: string
  ): Promise<void> {
    return this.request(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspace)}/branches/${encodeURIComponent(branch)}/rename`,
      { new_name: newName }
    );
  }
}

export const apiClient = new ApiClient();
