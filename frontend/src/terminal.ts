import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { logger } from './logger';
import { wsConnection } from './websocket';
import { TerminalSession, WsServerMessage } from './types';

interface ExtendedTerminalSession extends TerminalSession {
  sessionName?: string;
}

interface CaptureState {
  outputBlock: string;
  marker: string;
  buffer: string;
  isCapturing: boolean;
}

class TerminalManager {
  private terminals = new Map<string, ExtendedTerminalSession>();
  private pendingCommands = new Map<string, { command: string }>();
  // Map from named session names to session IDs
  private namedSessions = new Map<string, string>();
  // Track output captures in progress
  private captures = new Map<string, CaptureState>();
  // Callback to update named blocks
  private updateBlockCallback?: (blockName: string, content: string) => void;

  constructor() {
    wsConnection.setMessageHandler((msg) => this.handleMessage(msg));
  }

  setUpdateBlockCallback(callback: (blockName: string, content: string) => void): void {
    this.updateBlockCallback = callback;
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

          // Handle output capture if active
          const capture = this.captures.get(msg.session_id);
          if (capture && capture.isCapturing) {
            capture.buffer += msg.data;

            // Check if we've received the completion marker
            if (capture.buffer.includes(capture.marker)) {
              this.finalizeCapture(msg.session_id);
            }
          }
        } else {
          logger.warn(`No terminal found for session: ${msg.session_id}`);
        }
        break;
      }

      case 'closed':
        logger.info(`Session closed: ${msg.session_id}`);
        this.terminals.delete(msg.session_id);
        this.updateEmptyState();
        break;

      case 'error':
        logger.error('Server error:', msg.message);
        break;

      default:
        logger.warn('Unknown message type:', (msg as { type: string }).type);
    }
  }

  private getSessionsList(): HTMLElement | null {
    return document.getElementById('sessions');
  }

  private updateEmptyState(): void {
    const sessionsList = this.getSessionsList();
    if (!sessionsList) return;

    const emptyEl = sessionsList.querySelector('.sessions-empty') as HTMLElement;
    if (emptyEl) {
      emptyEl.style.display = this.terminals.size === 0 ? 'block' : 'none';
    }
  }

  createSession(sessionId: string): void {
    logger.info(`Creating session: ${sessionId}`);
    wsConnection.send({ type: 'create', id: sessionId });
  }

  sendInput(sessionId: string, data: string, outputBlock?: string): void {
    logger.debug(`Sending input to ${sessionId}:`, JSON.stringify(data));

    // If output capture is requested, start tracking
    if (outputBlock) {
      this.startCapture(sessionId, data, outputBlock);
    }

    wsConnection.send({ type: 'input', session_id: sessionId, data });
  }

  private startCapture(sessionId: string, command: string, outputBlock: string): void {
    const marker = `___BLOCK_END_${Date.now()}_${Math.random().toString(36).substr(2, 9)}___`;

    logger.info(`Starting output capture for session ${sessionId} -> block: ${outputBlock}`);

    this.captures.set(sessionId, {
      outputBlock,
      marker,
      buffer: '',
      isCapturing: true,
    });

    // Send the completion marker command after a small delay
    // This ensures it runs after the user's command
    setTimeout(() => {
      const markerCmd = `echo "${marker}"`;
      logger.debug(`Sending completion marker: ${markerCmd}`);
      wsConnection.send({ type: 'input', session_id: sessionId, data: markerCmd + '\n' });
    }, 100);
  }

  private finalizeCapture(sessionId: string): void {
    const capture = this.captures.get(sessionId);
    if (!capture) return;

    logger.info(`Finalizing capture for session ${sessionId}`);

    // Extract the output before the marker
    const markerIndex = capture.buffer.indexOf(capture.marker);
    if (markerIndex === -1) {
      logger.error('Marker not found in buffer, this should not happen');
      this.captures.delete(sessionId);
      return;
    }

    let output = capture.buffer.substring(0, markerIndex);

    // Strip ANSI escape sequences for cleaner output
    output = this.stripAnsi(output);

    // Trim trailing newlines and whitespace
    output = output.trimEnd();

    logger.debug(`Captured output (${output.length} chars) for block: ${capture.outputBlock}`);

    // Update the capture indicator UI
    const indicator = document.querySelector(`.capture-indicator[data-session-id="${sessionId}"]`) as HTMLElement;
    if (indicator) {
      indicator.textContent = `✅ Captured to: ${capture.outputBlock}`;
      indicator.classList.add('capture-complete');
      // Remove indicator after 3 seconds
      setTimeout(() => {
        indicator.style.opacity = '0';
        setTimeout(() => indicator.remove(), 300);
      }, 3000);
    }

    // Update the named block
    if (this.updateBlockCallback) {
      this.updateBlockCallback(capture.outputBlock, output);
    }

    // Clean up capture state
    this.captures.delete(sessionId);
  }

  private stripAnsi(text: string): string {
    // Remove ANSI escape codes (colors, cursor movement, etc.)
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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
      this.updateEmptyState();
    }
  }

  closeAllSessions(): void {
    logger.info('Closing all sessions');
    const sessionIds = Array.from(this.terminals.keys());
    for (const sessionId of sessionIds) {
      this.closeSession(sessionId);
    }
  }

  createTerminal(code: string, sessionName?: string, outputBlock?: string): string {
    const sessionsList = this.getSessionsList();
    if (!sessionsList) {
      logger.error('Sessions list element not found');
      return '';
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    logger.info(`Creating new terminal with session: ${sessionId}${sessionName ? ` (named: ${sessionName})` : ''}${outputBlock ? ` (capturing to: ${outputBlock})` : ''}`);

    // If output capture is requested, start tracking
    if (outputBlock) {
      this.startCapture(sessionId, code, outputBlock);
    }

    const termWrapper = document.createElement('div');
    termWrapper.className = 'terminal-wrapper';
    termWrapper.dataset.sessionId = sessionId;
    if (sessionName) {
      termWrapper.dataset.sessionName = sessionName;
    }

    const headerLabel = sessionName
      ? `<span class="terminal-session-name">${sessionName}</span>`
      : '<span>Terminal</span>';

    const captureIndicator = outputBlock
      ? `<span class="capture-indicator" data-session-id="${sessionId}">📝 Capturing to: ${outputBlock}</span>`
      : '';

    termWrapper.innerHTML = `
      <div class="terminal-header">
        ${headerLabel}
        ${captureIndicator}
        <button class="terminal-close" title="Close terminal">&times;</button>
      </div>
      <div class="terminal-container"></div>
    `;

    // Add to sessions list (at the top for newest first, or at bottom)
    sessionsList.appendChild(termWrapper);

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
      rows: 10,
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

    // Update empty state
    this.updateEmptyState();

    // Scroll terminal into view
    termWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    return sessionId;
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

  // Check if there are any active sessions
  hasActiveSessions(): boolean {
    return this.terminals.size > 0;
  }
}

export const terminalManager = new TerminalManager();
