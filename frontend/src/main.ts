import 'xterm/css/xterm.css';
import { logger } from './logger';
import { wsConnection } from './websocket';
import { createEditor } from './editor';
import { defaultContent } from './content';
import { terminalManager } from './terminal';

function initializeTabs(): void {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      const container = document.getElementById('container');
      if (container) {
        const view = (tab as HTMLElement).dataset.view || 'split';
        container.className = `container ${view}`;
      }
    });
  });
}

function initializeClearSessions(): void {
  const clearBtn = document.getElementById('clearSessions');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      logger.info('Clearing all sessions');
      terminalManager.closeAllSessions();
    });
  }
}

function main(): void {
  logger.info('===========================================');
  logger.info('  Runotepad - Frontend Initializing');
  logger.info('===========================================');
  logger.info(`Page URL: ${window.location.href}`);
  logger.info(`Protocol: ${window.location.protocol}`);
  logger.info(`Host: ${window.location.host}`);

  // Initialize tabs
  initializeTabs();

  // Initialize clear sessions button
  initializeClearSessions();

  // Create editor with run buttons in gutter
  const editorEl = document.getElementById('editor');
  if (editorEl) {
    createEditor(editorEl, defaultContent);
  } else {
    logger.error('Editor element not found');
  }

  // Connect WebSocket
  wsConnection.connect();

  logger.info('Initialization complete');
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
