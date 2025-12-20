import 'xterm/css/xterm.css';
import { logger } from './logger';
import { router } from './router';
import { renderLanding } from './pages/landing';
import { renderBrowser } from './pages/browser';
import { renderEditor } from './pages/editorPage';

function getAppContainer(): HTMLElement {
  const container = document.getElementById('app');
  if (!container) {
    throw new Error('App container not found');
  }
  return container;
}

function setupRoutes(): void {
  const container = getAppContainer();

  // Landing page (root)
  router.route('/', () => {
    renderLanding(container);
  });

  // File browser (workspace + branch)
  router.route('/:workspace/:branch/', (params) => {
    renderBrowser(container, params);
  });

  // Editor (workspace + branch + filepath)
  router.route('/:workspace/:branch/:filepath*', (params) => {
    renderEditor(container, params);
  });
}

function main(): void {
  logger.info('===========================================');
  logger.info('  Runotepad - Frontend Initializing');
  logger.info('===========================================');
  logger.info(`Page URL: ${window.location.href}`);
  logger.info(`Protocol: ${window.location.protocol}`);
  logger.info(`Host: ${window.location.host}`);

  // Setup routes
  setupRoutes();

  // Start router
  router.start();

  logger.info('Initialization complete');
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
