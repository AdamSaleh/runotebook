// WebSocket message types (client -> server)
export type WsClientMessage =
  | { type: 'create'; id: string }
  | { type: 'input'; session_id: string; data: string }
  | { type: 'resize'; session_id: string; cols: number; rows: number }
  | { type: 'close'; session_id: string }
  | {
      type: 'completion';
      request_id: string;
      workspace: string;
      branch: string;
      markdown_path: string;
      context: {
        context_type: string;
        prefix: string;
        document?: string;
      };
    };

// Completion item from server
export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  insert_text?: string;
}

// WebSocket message types (server -> client)
export type WsServerMessage =
  | { type: 'created'; session_id: string }
  | { type: 'output'; session_id: string; data: string }
  | { type: 'closed'; session_id: string }
  | { type: 'error'; message: string }
  | {
      type: 'completion_response';
      request_id: string;
      items: CompletionItem[];
      is_incomplete: boolean;
    };

// Terminal session data
export interface TerminalSession {
  terminal: import('xterm').Terminal;
  wrapper: HTMLElement;
  fitAddon: import('xterm-addon-fit').FitAddon;
}

// Workspace types
export interface Workspace {
  name: string;
  repo_url: string;
  base_branch: string;
  created_at: string;
}

export interface Branch {
  name: string;
  is_worktree: boolean;
  worktree_path: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

// Route params
export interface RouteParams {
  workspace?: string;
  branch?: string;
  filepath?: string;
}
