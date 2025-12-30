import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { logger } from './logger';
import { apiClient } from './api';

// Context for file operations - set by the editor page
let currentContext: {
  workspace: string;
  branch: string;
  markdownPath: string;
} | null = null;

export function setFileSyncContext(workspace: string, branch: string, markdownPath: string): void {
  currentContext = { workspace, branch, markdownPath };
  logger.debug(`File sync context set: ${workspace}/${branch}/${markdownPath}`);
}

export function clearFileSyncContext(): void {
  currentContext = null;
}

// State for each embedded file block
interface EmbeddedFileState {
  filePath: string;           // The file= path from annotation
  blockFrom: number;          // Start of fenced code block
  blockTo: number;            // End of fenced code block
  contentFrom: number;        // Start of code content
  contentTo: number;          // End of code content
  originalContent: string;    // Content when last synced with filesystem
  filesystemContent: string | null;  // Current filesystem content (null = not loaded)
  filesystemExists: boolean;  // Whether file exists on filesystem
}

// Effects for updating state
const setFilesystemContent = StateEffect.define<{
  filePath: string;
  content: string | null;
  exists: boolean;
}>();

const setOriginalContent = StateEffect.define<{
  filePath: string;
  content: string;
}>();

// Find all embedded file blocks in the document
function findEmbeddedBlocks(view: EditorView): Map<string, Omit<EmbeddedFileState, 'originalContent' | 'filesystemContent' | 'filesystemExists'>> {
  const blocks = new Map<string, Omit<EmbeddedFileState, 'originalContent' | 'filesystemContent' | 'filesystemExists'>>();
  const state = view.state;
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name === 'FencedCode') {
        const codeInfoNode = node.node.getChild('CodeInfo');
        if (!codeInfoNode) return;

        const infoText = state.doc.sliceString(codeInfoNode.from, codeInfoNode.to);
        const parts = infoText.trim().split(/\s+/);

        // Look for file= annotation
        let filePath: string | null = null;
        for (let i = 1; i < parts.length; i++) {
          const match = parts[i].match(/^file=(.+)$/);
          if (match) {
            filePath = match[1];
            break;
          }
        }

        if (!filePath) return;

        const codeTextNode = node.node.getChild('CodeText');
        if (!codeTextNode) return;

        blocks.set(filePath, {
          filePath,
          blockFrom: node.from,
          blockTo: node.to,
          contentFrom: codeTextNode.from,
          contentTo: codeTextNode.to,
        });
      }
    }
  });

  return blocks;
}

// Widget for file sync buttons
class FileSyncWidget extends WidgetType {
  constructor(
    private filePath: string,
    private showSave: boolean,
    private showLoad: boolean,
    private fileExists: boolean
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('span');
    container.className = 'file-sync-widget';

    // File path indicator
    const pathSpan = document.createElement('span');
    pathSpan.className = 'file-sync-path';
    pathSpan.textContent = this.filePath;
    pathSpan.title = this.fileExists ? 'Linked to file' : 'File does not exist';
    container.appendChild(pathSpan);

    if (this.showSave) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'file-sync-btn file-sync-save';
      saveBtn.textContent = 'Save';
      saveBtn.title = 'Save to file';
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleSave(view);
      });
      container.appendChild(saveBtn);
    }

    if (this.showLoad) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'file-sync-btn file-sync-load';
      loadBtn.textContent = 'Load';
      loadBtn.title = 'Load from file';
      loadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleLoad(view);
      });
      container.appendChild(loadBtn);
    }

    return container;
  }

  private async handleSave(view: EditorView): Promise<void> {
    if (!currentContext) {
      logger.error('No file sync context set');
      return;
    }

    const blocks = findEmbeddedBlocks(view);
    const block = blocks.get(this.filePath);
    if (!block) {
      logger.error(`Block not found for ${this.filePath}`);
      return;
    }

    const content = view.state.doc.sliceString(block.contentFrom, block.contentTo);

    try {
      await apiClient.saveEmbeddedFile(
        currentContext.workspace,
        currentContext.branch,
        currentContext.markdownPath,
        this.filePath,
        content
      );

      // Update both original and filesystem content
      view.dispatch({
        effects: [
          setOriginalContent.of({ filePath: this.filePath, content }),
          setFilesystemContent.of({ filePath: this.filePath, content, exists: true }),
        ]
      });

      logger.info(`Saved embedded file: ${this.filePath}`);
    } catch (err) {
      logger.error(`Failed to save ${this.filePath}: ${err}`);
    }
  }

  private async handleLoad(view: EditorView): Promise<void> {
    if (!currentContext) {
      logger.error('No file sync context set');
      return;
    }

    const blocks = findEmbeddedBlocks(view);
    const block = blocks.get(this.filePath);
    if (!block) {
      logger.error(`Block not found for ${this.filePath}`);
      return;
    }

    try {
      const result = await apiClient.readEmbeddedFile(
        currentContext.workspace,
        currentContext.branch,
        currentContext.markdownPath,
        this.filePath
      );

      if (!result.exists) {
        logger.warn(`File does not exist: ${this.filePath}`);
        return;
      }

      const content = result.content;

      // Replace the code block content
      view.dispatch({
        changes: {
          from: block.contentFrom,
          to: block.contentTo,
          insert: content,
        },
        effects: [
          setOriginalContent.of({ filePath: this.filePath, content }),
          setFilesystemContent.of({ filePath: this.filePath, content, exists: true }),
        ]
      });

      logger.info(`Loaded embedded file: ${this.filePath}`);
    } catch (err) {
      logger.error(`Failed to load ${this.filePath}: ${err}`);
    }
  }

  eq(other: WidgetType): boolean {
    return other instanceof FileSyncWidget &&
      other.filePath === this.filePath &&
      other.showSave === this.showSave &&
      other.showLoad === this.showLoad &&
      other.fileExists === this.fileExists;
  }
}

// StateField to track embedded file states
interface FileSyncState {
  files: Map<string, {
    originalContent: string;
    filesystemContent: string | null;
    filesystemExists: boolean;
    initialized: boolean;  // Whether we've checked the filesystem
  }>;
}

const fileSyncStateField = StateField.define<FileSyncState>({
  create() {
    return { files: new Map() };
  },
  update(state, tr) {
    let newState = state;

    for (const effect of tr.effects) {
      if (effect.is(setFilesystemContent)) {
        const files = new Map(newState.files);
        const existing = files.get(effect.value.filePath) || {
          originalContent: '',
          filesystemContent: null,
          filesystemExists: false,
          initialized: false,
        };
        files.set(effect.value.filePath, {
          ...existing,
          filesystemContent: effect.value.content,
          filesystemExists: effect.value.exists,
          initialized: true,
        });
        newState = { files };
      }

      if (effect.is(setOriginalContent)) {
        const files = new Map(newState.files);
        const existing = files.get(effect.value.filePath) || {
          originalContent: '',
          filesystemContent: null,
          filesystemExists: false,
          initialized: false,
        };
        files.set(effect.value.filePath, {
          ...existing,
          originalContent: effect.value.content,
        });
        newState = { files };
      }
    }

    return newState;
  }
});

// Compute decorations based on current state
function computeDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const blocks = findEmbeddedBlocks(view);
  const syncState = view.state.field(fileSyncStateField);

  for (const [filePath, block] of blocks) {
    const fileState = syncState.files.get(filePath);
    const currentContent = view.state.doc.sliceString(block.contentFrom, block.contentTo);

    // Don't show buttons until we've checked the filesystem
    const initialized = fileState?.initialized ?? false;
    if (!initialized) {
      // Show path indicator without buttons while loading
      const line = view.state.doc.lineAt(block.blockFrom);
      const widget = Decoration.widget({
        widget: new FileSyncWidget(filePath, false, false, false),
        side: 1,
      });
      decorations.push(widget.range(line.to));
      continue;
    }

    // Determine what buttons to show
    const originalContent = fileState?.originalContent ?? '';
    const filesystemContent = fileState?.filesystemContent;
    const filesystemExists = fileState?.filesystemExists ?? false;

    // Show Save if:
    // - Editor content differs from original (editor was modified), OR
    // - File doesn't exist (allow creating new file)
    const editorChanged = currentContent !== originalContent;
    const showSave = editorChanged || !filesystemExists;

    // Show Load if:
    // - File exists AND filesystem content differs from current editor content
    const showLoad = filesystemExists &&
      filesystemContent !== null &&
      filesystemContent !== currentContent;

    // Create widget decoration at the start of the code block line
    const line = view.state.doc.lineAt(block.blockFrom);
    const widget = Decoration.widget({
      widget: new FileSyncWidget(filePath, showSave, showLoad, filesystemExists),
      side: 1, // After the line content
    });
    decorations.push(widget.range(line.to));
  }

  return Decoration.set(decorations, true);
}

// Decoration field
const fileSyncDecorations = StateField.define<DecorationSet>({
  create(_state) {
    return Decoration.none;
  },
  update(_decorations, _tr) {
    return _decorations;
  },
  provide: f => EditorView.decorations.from(f)
});

// Plugin to manage decorations and fetch filesystem content
const fileSyncPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private pendingUpdate: number | null = null;
  private pendingFetch: number | null = null;
  private fetchedPaths: Set<string> = new Set();

  constructor(view: EditorView) {
    this.decorations = computeDecorations(view);
    this.scheduleFilesystemFetch(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      // Cancel pending update
      if (this.pendingUpdate !== null) {
        clearTimeout(this.pendingUpdate);
      }

      // Delay decoration update to allow syntax tree to settle
      this.pendingUpdate = window.setTimeout(() => {
        this.pendingUpdate = null;
        this.decorations = computeDecorations(update.view);
        update.view.dispatch({ effects: [] });
      }, 150);
    }

    // Also update if state effects changed the sync state
    for (const effect of update.transactions.flatMap(t => t.effects)) {
      if (effect.is(setFilesystemContent) || effect.is(setOriginalContent)) {
        this.decorations = computeDecorations(update.view);
        break;
      }
    }
  }

  private scheduleFilesystemFetch(view: EditorView): void {
    if (this.pendingFetch !== null) {
      clearTimeout(this.pendingFetch);
    }

    this.pendingFetch = window.setTimeout(() => {
      this.fetchFilesystemContent(view);
    }, 300);
  }

  private async fetchFilesystemContent(view: EditorView): Promise<void> {
    if (!currentContext) return;

    const blocks = findEmbeddedBlocks(view);

    for (const [filePath, block] of blocks) {
      if (this.fetchedPaths.has(filePath)) continue;
      this.fetchedPaths.add(filePath);

      try {
        const result = await apiClient.readEmbeddedFile(
          currentContext.workspace,
          currentContext.branch,
          currentContext.markdownPath,
          filePath
        );

        const content = result.exists ? result.content : null;
        const currentContent = view.state.doc.sliceString(block.contentFrom, block.contentTo);

        // On initial load, originalContent = what's currently in the editor (from markdown)
        // This way:
        // - Save button shows when editor content changes from initial state
        // - Load button shows when filesystem differs from what's in editor
        view.dispatch({
          effects: [
            setFilesystemContent.of({ filePath, content, exists: result.exists }),
            setOriginalContent.of({ filePath, content: currentContent }),
          ]
        });
      } catch (err) {
        logger.error(`Failed to fetch ${filePath}: ${err}`);
      }
    }
  }

  destroy() {
    if (this.pendingUpdate !== null) {
      clearTimeout(this.pendingUpdate);
    }
    if (this.pendingFetch !== null) {
      clearTimeout(this.pendingFetch);
    }
  }
}, {
  decorations: v => v.decorations
});

// Check for filesystem changes (call on focus or periodically)
export async function refreshFilesystemContent(view: EditorView): Promise<void> {
  if (!currentContext) return;

  const blocks = findEmbeddedBlocks(view);

  for (const filePath of blocks.keys()) {
    try {
      const result = await apiClient.readEmbeddedFile(
        currentContext.workspace,
        currentContext.branch,
        currentContext.markdownPath,
        filePath
      );

      const content = result.exists ? result.content : null;

      view.dispatch({
        effects: setFilesystemContent.of({ filePath, content, exists: result.exists })
      });
    } catch (err) {
      logger.error(`Failed to refresh ${filePath}: ${err}`);
    }
  }
}

// Export the extension
export function fileSyncExtension() {
  return [
    fileSyncStateField,
    fileSyncDecorations,
    fileSyncPlugin,
  ];
}
