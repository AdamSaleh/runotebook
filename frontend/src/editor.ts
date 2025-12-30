import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorState, RangeSet, StateField, Range } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { logger } from './logger';
import { terminalManager } from './terminal';
import { fileSyncExtension, refreshFilesystemContent } from './fileSync';
import { autocompleteExtension } from './autocomplete';

// Current runbook identifier for default session naming
let currentRunbookId: string | null = null;

export function setCurrentRunbook(runbookId: string): void {
  currentRunbookId = runbookId;
  logger.debug(`Set current runbook: ${runbookId}`);
}

function getDefaultSessionName(): string {
  if (!currentRunbookId) return 'default';
  // Create a clean session name from the runbook path
  return currentRunbookId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isShellLanguage(lang: string): boolean {
  return lang === 'sh' || lang === 'bash' || lang === 'shell';
}

/**
 * Get the content of a named code block from the current editor
 */
function getNamedBlockContent(blockName: string): string | null {
  if (!currentEditor) {
    return null;
  }

  const state = currentEditor.state;
  const tree = syntaxTree(state);
  let content: string | null = null;

  tree.iterate({
    enter(node) {
      if (content !== null) return false; // Already found

      if (node.name === 'FencedCode') {
        const codeInfoNode = node.node.getChild('CodeInfo');
        if (!codeInfoNode) return;

        const infoText = state.doc.sliceString(codeInfoNode.from, codeInfoNode.to);
        const parts = infoText.trim().split(/\s+/);

        // Look for name= annotation
        for (let i = 1; i < parts.length; i++) {
          const match = parts[i].match(/^name=(.+)$/);
          if (match && match[1] === blockName) {
            const codeTextNode = node.node.getChild('CodeText');
            if (codeTextNode) {
              content = state.doc.sliceString(codeTextNode.from, codeTextNode.to).trim();
              return false; // Stop iteration
            }
          }
        }
      }
    }
  });

  return content;
}

/**
 * Build environment variable export commands for envin blocks
 */
function buildEnvExports(envInBlocks: string[]): string {
  const exports: string[] = [];

  for (const blockName of envInBlocks) {
    const content = getNamedBlockContent(blockName);
    if (content !== null) {
      // Escape single quotes in the content by replacing ' with '\''
      const escaped = content.replace(/'/g, "'\\''");
      exports.push(`export ${blockName}='${escaped}'`);
      logger.debug(`Injecting env var ${blockName} (${content.length} chars)`);
    } else {
      logger.warn(`envin block not found: ${blockName}`);
    }
  }

  return exports.length > 0 ? exports.join('; ') + '; ' : '';
}

// GutterMarker that renders a run button
class RunButtonMarker extends GutterMarker {
  constructor(
    private code: string,
    private sessionName?: string,
    private outputBlock?: string,
    private envInBlocks?: string[]
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'run-gutter-btn';
    btn.innerHTML = '&#9654;'; // Play triangle
    const displayName = this.sessionName || getDefaultSessionName();
    btn.title = `Run in session: ${displayName}`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.runCode();
    });

    return btn;
  }

  private runCode(): void {
    const sessionName = this.sessionName || getDefaultSessionName();
    const envInfo = this.envInBlocks?.length ? ` (envin: ${this.envInBlocks.join(',')})` : '';
    logger.info(`Running code in session: ${sessionName}${this.outputBlock ? ` (capturing to: ${this.outputBlock})` : ''}${envInfo}`);

    // Build the code with env exports prepended
    let codeToRun = this.code;
    if (this.envInBlocks && this.envInBlocks.length > 0) {
      const envExports = buildEnvExports(this.envInBlocks);
      codeToRun = envExports + this.code;
    }

    logger.debug('Code to execute:', codeToRun);

    // Check for existing named session, reuse or create new
    const existingId = terminalManager.getNamedSession(sessionName);
    if (existingId) {
      logger.debug(`Reusing session "${sessionName}": ${existingId}`);
      terminalManager.sendInput(existingId, codeToRun + '\n', this.outputBlock);
      terminalManager.scrollSessionIntoView(existingId);
      return;
    }

    terminalManager.createTerminal(codeToRun, sessionName, this.outputBlock);
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RunButtonMarker &&
      other.code === this.code &&
      other.sessionName === this.sessionName &&
      other.outputBlock === this.outputBlock &&
      JSON.stringify(other.envInBlocks) === JSON.stringify(this.envInBlocks);
  }
}

// Compute markers for all shell code blocks
function computeMarkers(state: EditorState): RangeSet<GutterMarker> {
  const markers: Range<GutterMarker>[] = [];

  // Ensure syntax tree is fully parsed (wait up to 100ms)
  const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name === 'FencedCode') {
        // Get the CodeMark (opening ```) and CodeInfo nodes
        const codeInfoNode = node.node.getChild('CodeInfo');
        if (!codeInfoNode) return;

        const infoText = state.doc.sliceString(codeInfoNode.from, codeInfoNode.to);
        const parts = infoText.trim().split(/\s+/);
        const lang = parts[0] || '';

        if (!isShellLanguage(lang)) return;

        // Parse session name, output block, and envin from info string
        let sessionName: string | undefined;
        let outputBlock: string | undefined;
        let envInBlocks: string[] | undefined;
        for (let i = 1; i < parts.length; i++) {
          const sessionMatch = parts[i].match(/^session=(.+)$/);
          if (sessionMatch) {
            sessionName = sessionMatch[1];
            continue;
          }
          const outMatch = parts[i].match(/^out=(.+)$/);
          if (outMatch) {
            outputBlock = outMatch[1];
            continue;
          }
          const envinMatch = parts[i].match(/^envin=(.+)$/);
          if (envinMatch) {
            // Parse comma-separated block names
            envInBlocks = envinMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
            continue;
          }
        }

        // Extract code content (between the code marks)
        const codeTextNode = node.node.getChild('CodeText');
        let code = '';
        if (codeTextNode) {
          code = state.doc.sliceString(codeTextNode.from, codeTextNode.to).trim();
        }

        if (!code) return;

        // Add marker at the start of the fenced code block
        const line = state.doc.lineAt(node.from);
        markers.push(new RunButtonMarker(code, sessionName, outputBlock, envInBlocks).range(line.from));
      }
    }
  });

  return RangeSet.of(markers, true);
}

// StateField to track code block markers
const codeBlockField = StateField.define<RangeSet<GutterMarker>>({
  create(state) {
    return computeMarkers(state);
  },
  update(_markers, tr) {
    // Always recompute markers - the syntaxUpdatePlugin will trigger
    // additional updates after parsing completes
    return computeMarkers(tr.state);
  }
});

// Run button gutter
const runGutter = gutter({
  class: 'cm-run-gutter',
  markers: (view) => view.state.field(codeBlockField),
});

// Plugin to force re-parsing when document changes
const syntaxUpdatePlugin = ViewPlugin.fromClass(class {
  private pendingUpdate: number | null = null;

  update(update: ViewUpdate) {
    if (update.docChanged) {
      // Cancel any pending update
      if (this.pendingUpdate !== null) {
        clearTimeout(this.pendingUpdate);
      }
      // Schedule re-computation after a short delay to allow parsing
      this.pendingUpdate = window.setTimeout(() => {
        this.pendingUpdate = null;
        // Trigger a state update to recompute markers
        update.view.dispatch({
          effects: [],
        });
      }, 150);
    }
  }

  destroy() {
    if (this.pendingUpdate !== null) {
      clearTimeout(this.pendingUpdate);
    }
  }
});

export type ContentChangeHandler = (content: string) => void;

// Store reference to current editor
let currentEditor: EditorView | null = null;

export function createEditor(
  parent: HTMLElement,
  initialContent: string,
  onContentChange?: ContentChangeHandler
): EditorView {
  logger.info('Creating CodeMirror editor with run gutter');

  // Destroy existing editor if present
  if (currentEditor) {
    currentEditor.destroy();
    currentEditor = null;
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onContentChange) {
      onContentChange(update.state.doc.toString());
    }

    // Update cursor position
    const pos = update.state.selection.main.head;
    const line = update.state.doc.lineAt(pos);
    const cursorPosEl = document.getElementById('cursorPos');
    if (cursorPosEl) {
      cursorPosEl.textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
    }
  });

  const editor = new EditorView({
    state: EditorState.create({
      doc: initialContent,
      extensions: [
        codeBlockField,
        runGutter,
        syntaxUpdatePlugin,
        fileSyncExtension(),
        autocompleteExtension(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        oneDark,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        updateListener,
        EditorView.lineWrapping,
      ],
    }),
    parent,
  });

  logger.info('CodeMirror editor created successfully');
  currentEditor = editor;

  // Set up terminal manager callback for updating named blocks
  terminalManager.setUpdateBlockCallback(updateNamedBlock);

  return editor;
}

export function getEditorContent(): string {
  return currentEditor?.state.doc.toString() ?? '';
}

export function setEditorContent(content: string): void {
  if (currentEditor) {
    currentEditor.dispatch({
      changes: {
        from: 0,
        to: currentEditor.state.doc.length,
        insert: content,
      },
    });
  }
}

export function getEditorView(): EditorView | null {
  return currentEditor;
}

/**
 * Update a named code block's content
 */
export function updateNamedBlock(blockName: string, content: string): void {
  if (!currentEditor) {
    logger.error('No editor available to update named block');
    return;
  }

  const state = currentEditor.state;
  const tree = syntaxTree(state);

  // Find the code block with name=blockName
  let targetBlock: { from: number; to: number; contentFrom: number; contentTo: number } | null = null;

  tree.iterate({
    enter(node) {
      if (targetBlock) return false; // Already found

      if (node.name === 'FencedCode') {
        const codeInfoNode = node.node.getChild('CodeInfo');
        if (!codeInfoNode) return;

        const infoText = state.doc.sliceString(codeInfoNode.from, codeInfoNode.to);
        const parts = infoText.trim().split(/\s+/);

        // Look for name= annotation
        for (let i = 1; i < parts.length; i++) {
          const match = parts[i].match(/^name=(.+)$/);
          if (match && match[1] === blockName) {
            const codeTextNode = node.node.getChild('CodeText');
            if (codeTextNode) {
              targetBlock = {
                from: node.from,
                to: node.to,
                contentFrom: codeTextNode.from,
                contentTo: codeTextNode.to,
              };
              return false; // Stop iteration
            }
          }
        }
      }
    }
  });

  if (!targetBlock) {
    logger.warn(`Named block not found: ${blockName}`);
    return;
  }

  logger.info(`Updating named block: ${blockName} with ${content.length} chars`);

  // Extract values to work around TypeScript control flow analysis limitation
  const { contentFrom, contentTo } = targetBlock;

  // Replace the content
  currentEditor.dispatch({
    changes: {
      from: contentFrom,
      to: contentTo,
      insert: content,
    }
  });
}

// Re-export for convenience
export { refreshFilesystemContent } from './fileSync';
