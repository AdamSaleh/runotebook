import { marked, Renderer } from 'marked';
import { logger } from './logger';
import { terminalManager } from './terminal';

let blockId = 0;

interface CodeToken {
  text?: string;
  lang?: string;
}

interface CodeBlockMeta {
  language: string;
  session?: string;
}

// Parse the info string from a code fence (e.g., "sh session=myshell")
function parseCodeFenceInfo(infoString: string): CodeBlockMeta {
  const parts = infoString.trim().split(/\s+/);
  const language = parts[0] || '';
  let session: string | undefined;

  // Parse key=value pairs
  for (let i = 1; i < parts.length; i++) {
    const match = parts[i].match(/^session=(.+)$/);
    if (match) {
      session = match[1];
    }
  }

  return { language, session };
}

function isShellLanguage(lang: string): boolean {
  return lang === 'sh' || lang === 'bash' || lang === 'shell';
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
    let langInfo: string;

    if (typeof codeOrToken === 'object' && codeOrToken !== null) {
      code = codeOrToken.text || '';
      langInfo = codeOrToken.lang || '';
    } else {
      code = codeOrToken || '';
      langInfo = language || '';
    }

    const { language: lang, session } = parseCodeFenceInfo(langInfo);
    const id = `block-${blockId++}`;
    const escapedCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (isShellLanguage(lang)) {
      const sessionAttr = session ? `data-session="${session}"` : '';
      const sessionBadge = session
        ? `<span class="session-badge" title="Session: ${session}">${session}</span>`
        : '';

      return `
        <div class="code-block-wrapper" id="${id}" ${session ? `data-session="${session}"` : ''}>
          <div class="code-block-header">
            ${sessionBadge}
          </div>
          <pre><code class="language-${lang}">${escapedCode}</code></pre>
          <button class="run-btn" data-block-id="${id}" data-code="${encodeURIComponent(code)}" ${sessionAttr}>
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
  const sessionName = btn.dataset.session;

  if (!blockIdAttr) {
    logger.error('No block ID found on button');
    return;
  }

  logger.info(`Running code block: ${blockIdAttr}${sessionName ? ` (session: ${sessionName})` : ''}`);
  logger.debug('Code to execute:', code);

  // If this block has a named session, check if that session already exists
  if (sessionName) {
    const existingSessionId = terminalManager.getNamedSession(sessionName);
    if (existingSessionId) {
      logger.debug(`Reusing named session "${sessionName}": ${existingSessionId}`);
      // Send code to the existing session
      terminalManager.sendInput(existingSessionId, code + '\n');
      // Scroll the terminal into view in the sessions pane
      terminalManager.scrollSessionIntoView(existingSessionId);
      btn.disabled = true;
      setTimeout(() => {
        btn.disabled = false;
      }, 500);
      return;
    }
  }

  // Create new terminal in the sessions pane (with optional session name)
  terminalManager.createTerminal(code, sessionName);

  btn.disabled = true;
  setTimeout(() => {
    btn.disabled = false;
  }, 500);
}
