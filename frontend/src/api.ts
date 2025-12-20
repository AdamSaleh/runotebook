import { logger } from './logger';
import { authManager } from './auth';
import type { Workspace, Branch, FileEntry } from './types';

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
