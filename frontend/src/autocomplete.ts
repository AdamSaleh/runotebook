/**
 * Code completion module for Runotepad
 *
 * Provides completions for:
 * - File paths (file=./path directives)
 * - Block names (name= and out= directives)
 * - Shell commands (inside shell code blocks)
 * - Shell history (via Atuin if available)
 */

import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { wsConnection } from './websocket';
import { logger } from './logger';

// Completion context for the current file
let completionContext: {
  workspace: string;
  branch: string;
  markdownPath: string;
} | null = null;

/**
 * Set the completion context (workspace, branch, file path)
 */
export function setCompletionContext(workspace: string, branch: string, markdownPath: string): void {
  completionContext = { workspace, branch, markdownPath };
  logger.debug(`Completion context set: ${workspace}/${branch}/${markdownPath}`);
}

/**
 * Clear the completion context
 */
export function clearCompletionContext(): void {
  completionContext = null;
}

// Pending completion requests
const pendingRequests = new Map<string, {
  resolve: (result: CompletionResult | null) => void;
  from: number;
}>();

/**
 * Completion item from the server
 */
interface ServerCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  insert_text?: string;
}

/**
 * Handle completion response from WebSocket
 */
export function handleCompletionResponse(response: {
  request_id: string;
  items: ServerCompletionItem[];
  is_incomplete: boolean;
}): void {
  const pending = pendingRequests.get(response.request_id);
  if (!pending) {
    logger.warn(`No pending request for completion: ${response.request_id}`);
    return;
  }

  pendingRequests.delete(response.request_id);

  const completions: Completion[] = response.items.map(item => ({
    label: item.label,
    type: mapCompletionKind(item.kind),
    detail: item.detail,
    apply: item.insert_text || item.label,
  }));

  logger.debug(`Received ${completions.length} completions for ${response.request_id}`);

  pending.resolve({
    from: pending.from,
    options: completions,
  });
}

/**
 * Map server completion kind to CodeMirror type
 */
function mapCompletionKind(kind: string): string {
  switch (kind) {
    case 'file': return 'file';
    case 'folder': return 'folder';
    case 'variable': return 'variable';
    case 'function': return 'function';
    case 'text': return 'text';
    default: return 'text';
  }
}

/**
 * Context info for a completion request
 */
interface CompletionContextInfo {
  type: string;
  prefix: string;
  from: number;
}

/**
 * Determine completion context from cursor position
 */
function getCompletionContextType(
  view: EditorView,
  pos: number
): CompletionContextInfo | null {
  const tree = syntaxTree(view.state);
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const posInLine = pos - line.from;

  // Check if we're in a FencedCode block
  let inCodeBlock = false;
  let codeBlockInfo = '';

  tree.iterate({
    enter(node) {
      if (node.name === 'FencedCode' && node.from <= pos && node.to >= pos) {
        inCodeBlock = true;

        const infoNode = node.node.getChild('CodeInfo');
        if (infoNode) {
          codeBlockInfo = view.state.doc.sliceString(infoNode.from, infoNode.to);
        }
      }
    }
  });

  // Check for file= completion (in info string on fence line)
  const fileMatch = lineText.match(/file=([^\s]*)$/);
  if (fileMatch) {
    const matchStart = lineText.lastIndexOf('file=');
    if (posInLine >= matchStart) {
      return {
        type: 'file_path',
        prefix: fileMatch[1],
        from: line.from + matchStart + 5, // 5 = length of "file="
      };
    }
  }

  // Check for name= completion (in info string)
  const nameMatch = lineText.match(/name=([^\s]*)$/);
  if (nameMatch) {
    const matchStart = lineText.lastIndexOf('name=');
    if (posInLine >= matchStart) {
      return {
        type: 'block_name',
        prefix: nameMatch[1],
        from: line.from + matchStart + 5,
      };
    }
  }

  // Check for out= completion (in info string)
  const outMatch = lineText.match(/out=([^\s]*)$/);
  if (outMatch) {
    const matchStart = lineText.lastIndexOf('out=');
    if (posInLine >= matchStart) {
      return {
        type: 'block_name',
        prefix: outMatch[1],
        from: line.from + matchStart + 4,
      };
    }
  }

  // Check for shell completion (inside shell code block)
  if (inCodeBlock) {
    const parts = codeBlockInfo.trim().split(/\s+/);
    const lang = parts[0] || '';

    if (['sh', 'bash', 'shell'].includes(lang)) {
      // Find the word before cursor
      const beforeCursor = lineText.substring(0, posInLine);
      const wordMatch = beforeCursor.match(/(\S+)$/);
      const prefix = wordMatch ? wordMatch[1] : '';
      const from = wordMatch ? line.from + posInLine - prefix.length : pos;

      // Only complete if we have some prefix or at start of word
      if (prefix.length > 0 || beforeCursor.endsWith(' ') || beforeCursor === '') {
        return {
          type: 'shell_command',
          prefix,
          from,
        };
      }
    }
  }

  return null;
}

/**
 * Check if we should trigger completion based on what was typed
 */
function shouldTriggerCompletion(context: CompletionContext, ctxInfo: CompletionContextInfo): boolean {
  // Always complete for explicit requests
  if (context.explicit) {
    return true;
  }

  // Check for trigger characters
  const charBefore = context.state.doc.sliceString(context.pos - 1, context.pos);
  const triggerChars = ['=', '/', ' ', '.'];

  if (triggerChars.includes(charBefore)) {
    return true;
  }

  // For shell commands, require at least 2 characters
  if (ctxInfo.type === 'shell_command' && ctxInfo.prefix.length >= 2) {
    return true;
  }

  // For file paths and block names, any prefix is fine after trigger
  if ((ctxInfo.type === 'file_path' || ctxInfo.type === 'block_name') && ctxInfo.prefix.length >= 0) {
    return true;
  }

  return false;
}

/**
 * Main completion source
 */
async function runotepadCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
  if (!completionContext) {
    return null;
  }

  // Check if WebSocket is connected
  if (!wsConnection.isConnected) {
    return null;
  }

  // Ensure we have a view
  if (!context.view) {
    return null;
  }

  const ctxInfo = getCompletionContextType(context.view, context.pos);
  if (!ctxInfo) {
    return null;
  }

  // Check if we should trigger completion
  if (!shouldTriggerCompletion(context, ctxInfo)) {
    return null;
  }

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  return new Promise<CompletionResult | null>((resolve) => {
    pendingRequests.set(requestId, {
      resolve,
      from: ctxInfo.from,
    });

    // Set timeout to avoid hanging
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        logger.warn(`Completion request timed out: ${requestId}`);
        resolve(null);
      }
    }, 2000);

    // Send completion request
    const message = {
      type: 'completion' as const,
      request_id: requestId,
      workspace: completionContext!.workspace,
      branch: completionContext!.branch,
      markdown_path: completionContext!.markdownPath,
      context: {
        context_type: ctxInfo.type,
        prefix: ctxInfo.prefix,
        document: ctxInfo.type === 'block_name' ? context.state.doc.toString() : undefined,
      },
    };

    logger.debug(`Sending completion request: ${requestId} (${ctxInfo.type})`);

    const sent = wsConnection.send(message);
    if (!sent) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      resolve(null);
    }
  });
}

/**
 * Create the autocomplete extension for CodeMirror
 */
export function autocompleteExtension() {
  return autocompletion({
    override: [runotepadCompletionSource],
    activateOnTyping: true,
    maxRenderedOptions: 50,
  });
}
