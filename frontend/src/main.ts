import 'xterm/css/xterm.css';
import { logger } from './logger';
import { wsConnection } from './websocket';
import { createEditor } from './editor';
import { initializePreview, updatePreview } from './preview';
import { defaultContent } from './content';

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

function main(): void {
  logger.info('===========================================');
  logger.info('  Runotepad - Frontend Initializing');
  logger.info('===========================================');
  logger.info(`Page URL: ${window.location.href}`);
  logger.info(`Protocol: ${window.location.protocol}`);
  logger.info(`Host: ${window.location.host}`);

  // Initialize marked renderer
  initializePreview();

  // Initialize tabs
  initializeTabs();

  // Create editor
  const editorEl = document.getElementById('editor');
  if (editorEl) {
    createEditor(editorEl, defaultContent, updatePreview);
  } else {
    logger.error('Editor element not found');
  }

  // Initial preview render
  updatePreview(defaultContent);

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
