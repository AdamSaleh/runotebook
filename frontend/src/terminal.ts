import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { logger } from './logger';
import { wsConnection } from './websocket';
import { TerminalSession, WsServerMessage } from './types';

interface ExtendedTerminalSession extends TerminalSession {
  sessionName?: string;
}

class TerminalManager {
  private terminals = new Map<string, ExtendedTerminalSession>();
  private pendingCommands = new Map<string, { command: string }>();
  // Map from named session names to session IDs
  private namedSessions = new Map<string, string>();

  constructor() {
    wsConnection.setMessageHandler((msg) => this.handleMessage(msg));
  }

  private handleMessage(msg: WsServerMessage): void {
    logger.debug('Handling message:', msg.type, msg);

    switch (msg.type) {
      case 'created': {
        logger.info(`Session created: ${msg.session_id}`);
        const pending = this.pendingCommands.get(msg.session_id);
        if (pending) {
          logger.debug(`Sending pending command for ${msg.session_id}:`, pending.command);
          this.sendInput(msg.session_id, pending.command + '\n');
          this.pendingCommands.delete(msg.session_id);
        } else {
          logger.warn(`No pending command for session: ${msg.session_id}`);
        }
        break;
      }

      case 'output': {
        const termData = this.terminals.get(msg.session_id);
        if (termData?.terminal) {
          termData.terminal.write(msg.data);
        } else {
          logger.warn(`No terminal found for session: ${msg.session_id}`);
        }
        break;
      }

      case 'closed':
        logger.info(`Session closed: ${msg.session_id}`);
        this.terminals.delete(msg.session_id);
        break;

      case 'error':
        logger.error('Server error:', msg.message);
        break;

      default:
        logger.warn('Unknown message type:', (msg as { type: string }).type);
    }
  }

  createSession(sessionId: string): void {
    logger.info(`Creating session: ${sessionId}`);
    wsConnection.send({ type: 'create', id: sessionId });
  }

  sendInput(sessionId: string, data: string): void {
    logger.debug(`Sending input to ${sessionId}:`, JSON.stringify(data));
    wsConnection.send({ type: 'input', session_id: sessionId, data });
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    logger.debug(`Resizing ${sessionId} to ${cols}x${rows}`);
    wsConnection.send({ type: 'resize', session_id: sessionId, cols, rows });
  }

  closeSession(sessionId: string): void {
    logger.info(`Closing session: ${sessionId}`);
    wsConnection.send({ type: 'close', session_id: sessionId });

    const termData = this.terminals.get(sessionId);
    if (termData) {
      // Remove from named sessions if it was a named session
      if (termData.sessionName) {
        this.namedSessions.delete(termData.sessionName);
        logger.debug(`Removed named session: ${termData.sessionName}`);
      }
      termData.terminal.dispose();
      termData.wrapper.remove();
      this.terminals.delete(sessionId);
    }
  }

  createTerminalForBlock(wrapper: HTMLElement, code: string, sessionName?: string): string {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    logger.info(`Creating new terminal with session: ${sessionId}${sessionName ? ` (named: ${sessionName})` : ''}`);

    const termWrapper = document.createElement('div');
    termWrapper.className = 'terminal-wrapper';
    termWrapper.dataset.sessionId = sessionId;
    if (sessionName) {
      termWrapper.dataset.sessionName = sessionName;
    }

    const headerLabel = sessionName
      ? `<span class="terminal-session-name">${sessionName}</span>`
      : '<span>Terminal</span>';

    termWrapper.innerHTML = `
      <div class="terminal-header">
        ${headerLabel}
        <button class="terminal-close" title="Close terminal">&times;</button>
      </div>
      <div class="terminal-container"></div>
    `;

    wrapper.appendChild(termWrapper);

    const termContainer = termWrapper.querySelector('.terminal-container') as HTMLElement;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      rows: 12,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termContainer);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData((data) => {
      this.sendInput(sessionId, data);
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      this.resizeTerminal(sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(termContainer);

    // Store terminal reference with session name
    this.terminals.set(sessionId, { terminal, wrapper: termWrapper, fitAddon, sessionName });

    // Register named session if provided
    if (sessionName) {
      this.namedSessions.set(sessionName, sessionId);
      logger.debug(`Registered named session: ${sessionName} -> ${sessionId}`);
    }

    // Close button handler
    termWrapper.querySelector('.terminal-close')?.addEventListener('click', () => {
      this.closeSession(sessionId);
    });

    // Store pending command and create session
    this.pendingCommands.set(sessionId, { command: code });
    this.createSession(sessionId);

    return sessionId;
  }

  getExistingSession(wrapper: HTMLElement): string | null {
    const existingTerminal = wrapper.querySelector('.terminal-wrapper') as HTMLElement;
    return existingTerminal?.dataset.sessionId || null;
  }

  // Get session ID for a named session
  getNamedSession(sessionName: string): string | null {
    return this.namedSessions.get(sessionName) || null;
  }

  // Scroll a session's terminal into view and focus it
  scrollSessionIntoView(sessionId: string): void {
    const termData = this.terminals.get(sessionId);
    if (termData?.wrapper) {
      termData.wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Flash the terminal to indicate it received input
      termData.wrapper.classList.add('terminal-flash');
      setTimeout(() => {
        termData.wrapper.classList.remove('terminal-flash');
      }, 500);
      // Focus the terminal
      termData.terminal.focus();
    }
  }
}

export const terminalManager = new TerminalManager();
