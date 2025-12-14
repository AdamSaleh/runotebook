import { marked, Renderer } from 'marked';
import { logger } from './logger';
import { terminalManager } from './terminal';

let blockId = 0;

interface CodeToken {
  text?: string;
  lang?: string;
}

function createRenderer(): Renderer {
  const renderer = new Renderer();

  // Handle both old API (code, language, escaped) and new API ({ text, lang })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (renderer as any).code = function (
    codeOrToken: string | CodeToken,
    language?: string
  ): string {
    let code: string;
    let lang: string;

    if (typeof codeOrToken === 'object' && codeOrToken !== null) {
      code = codeOrToken.text || '';
      lang = codeOrToken.lang || '';
    } else {
      code = codeOrToken || '';
      lang = language || '';
    }

    const id = `block-${blockId++}`;
    const escapedCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (lang === 'sh' || lang === 'bash' || lang === 'shell') {
      return `
        <div class="code-block-wrapper" id="${id}">
          <pre><code class="language-${lang}">${escapedCode}</code></pre>
          <button class="run-btn" data-block-id="${id}" data-code="${encodeURIComponent(code)}">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Run
          </button>
        </div>
      `;
    }

    return `
      <div class="code-block-wrapper">
        <pre><code class="language-${lang}">${escapedCode}</code></pre>
      </div>
    `;
  };

  return renderer;
}

export function initializePreview(): void {
  marked.setOptions({
    renderer: createRenderer(),
    gfm: true,
    breaks: true,
  });
}

export function updatePreview(content: string): void {
  blockId = 0;
  const preview = document.getElementById('preview');
  if (!preview) {
    logger.error('Preview element not found');
    return;
  }

  preview.innerHTML = marked.parse(content) as string;

  // Attach click handlers to run buttons
  preview.querySelectorAll('.run-btn').forEach((btn) => {
    btn.addEventListener('click', () => runCodeBlock(btn as HTMLButtonElement));
  });
}

function runCodeBlock(btn: HTMLButtonElement): void {
  const blockIdAttr = btn.dataset.blockId;
  const code = decodeURIComponent(btn.dataset.code || '');

  if (!blockIdAttr) {
    logger.error('No block ID found on button');
    return;
  }

  const wrapper = document.getElementById(blockIdAttr);
  if (!wrapper) {
    logger.error(`Block wrapper not found: ${blockIdAttr}`);
    return;
  }

  logger.info(`Running code block: ${blockIdAttr}`);
  logger.debug('Code to execute:', code);

  // Check if terminal already exists for this block
  const existingSessionId = terminalManager.getExistingSession(wrapper);
  if (existingSessionId) {
    logger.debug(`Reusing existing session: ${existingSessionId}`);
    terminalManager.sendInput(existingSessionId, code + '\n');
    return;
  }

  // Create new terminal
  terminalManager.createTerminalForBlock(wrapper, code);

  btn.disabled = true;
  setTimeout(() => {
    btn.disabled = false;
  }, 500);
}
