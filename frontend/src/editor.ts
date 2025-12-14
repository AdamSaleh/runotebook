import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { logger } from './logger';

export type ContentChangeHandler = (content: string) => void;

export function createEditor(
  parent: HTMLElement,
  initialContent: string,
  onContentChange: ContentChangeHandler
): EditorView {
  logger.info('Creating CodeMirror editor');

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
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
