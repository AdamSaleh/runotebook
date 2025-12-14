// WebSocket message types (client -> server)
export type WsClientMessage =
  | { type: 'create'; id: string }
  | { type: 'input'; session_id: string; data: string }
  | { type: 'resize'; session_id: string; cols: number; rows: number }
  | { type: 'close'; session_id: string };

// WebSocket message types (server -> client)
export type WsServerMessage =
  | { type: 'created'; session_id: string }
  | { type: 'output'; session_id: string; data: string }
  | { type: 'closed'; session_id: string }
  | { type: 'error'; message: string };

// Terminal session data
export interface TerminalSession {
  terminal: import('xterm').Terminal;
  wrapper: HTMLElement;
  fitAddon: import('xterm-addon-fit').FitAddon;
}
