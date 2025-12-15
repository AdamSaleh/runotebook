import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, RangeSet, StateField, Range } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, syntaxTree } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { logger } from './logger';
import { terminalManager } from './terminal';

function isShellLanguage(lang: string): boolean {
  return lang === 'sh' || lang === 'bash' || lang === 'shell';
}

// GutterMarker that renders a run button
class RunButtonMarker extends GutterMarker {
  constructor(
    private code: string,
    private sessionName?: string
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'run-gutter-btn';
    btn.innerHTML = '&#9654;'; // Play triangle
    btn.title = this.sessionName
      ? `Run in session: ${this.sessionName}`
      : 'Run in new terminal';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.runCode();
    });

    return btn;
  }

  private runCode(): void {
    logger.info(`Running code${this.sessionName ? ` in session: ${this.sessionName}` : ''}`);
    logger.debug('Code to execute:', this.code);

    // Check for existing named session, reuse or create new
    if (this.sessionName) {
      const existingId = terminalManager.getNamedSession(this.sessionName);
      if (existingId) {
        logger.debug(`Reusing named session "${this.sessionName}": ${existingId}`);
        terminalManager.sendInput(existingId, this.code + '\n');
        terminalManager.scrollSessionIntoView(existingId);
        return;
      }
    }

    terminalManager.createTerminal(this.code, this.sessionName);
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RunButtonMarker &&
      other.code === this.code &&
      other.sessionName === this.sessionName;
  }
}

// Compute markers for all shell code blocks
function computeMarkers(state: EditorState): RangeSet<GutterMarker> {
  const markers: Range<GutterMarker>[] = [];
  const tree = syntaxTree(state);

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

        // Parse session name from info string
        let sessionName: string | undefined;
        for (let i = 1; i < parts.length; i++) {
          const match = parts[i].match(/^session=(.+)$/);
          if (match) {
            sessionName = match[1];
            break;
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
        markers.push(new RunButtonMarker(code, sessionName).range(line.from));
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
  update(markers, tr) {
    if (tr.docChanged) {
      return computeMarkers(tr.state);
    }
    return markers;
  }
});

// Run button gutter
const runGutter = gutter({
  class: 'cm-run-gutter',
  markers: (view) => view.state.field(codeBlockField),
});

export type ContentChangeHandler = (content: string) => void;

export function createEditor(
  parent: HTMLElement,
  initialContent: string,
  onContentChange?: ContentChangeHandler
): EditorView {
  logger.info('Creating CodeMirror editor with run gutter');

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
  return editor;
}
