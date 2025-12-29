import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorState, RangeSet, StateField, Range } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { logger } from './logger';
import { terminalManager } from './terminal';
import { fileSyncExtension, refreshFilesystemContent } from './fileSync';

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

// GutterMarker that renders a run button
class RunButtonMarker extends GutterMarker {
  constructor(
    private code: string,
    private sessionName?: string,
    private outputBlock?: string
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
    logger.info(`Running code in session: ${sessionName}${this.outputBlock ? ` (capturing to: ${this.outputBlock})` : ''}`);
    logger.debug('Code to execute:', this.code);

    // Check for existing named session, reuse or create new
    const existingId = terminalManager.getNamedSession(sessionName);
    if (existingId) {
      logger.debug(`Reusing session "${sessionName}": ${existingId}`);
      terminalManager.sendInput(existingId, this.code + '\n', this.outputBlock);
      terminalManager.scrollSessionIntoView(existingId);
      return;
    }

    terminalManager.createTerminal(this.code, sessionName, this.outputBlock);
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RunButtonMarker &&
      other.code === this.code &&
      other.sessionName === this.sessionName &&
      other.outputBlock === this.outputBlock;
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

        // Parse session name and output block from info string
        let sessionName: string | undefined;
        let outputBlock: string | undefined;
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
        markers.push(new RunButtonMarker(code, sessionName, outputBlock).range(line.from));
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
