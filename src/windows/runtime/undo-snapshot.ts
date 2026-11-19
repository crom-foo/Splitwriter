export type CurlyConfig = {
  enabled: boolean;
  map: { left: string; right: string };
};

type Hooks = { scheduleSave?: () => void; onChange?: (html: string) => void };
type Opts = {
  boardId: string;
  limit?: number;
  curly?: CurlyConfig | (() => CurlyConfig);
  hooks?: Hooks;
};

type Endpoint = {
  paragraph: number;
  path: number[];
  nodeType: number;
  offset: number;
  textOffset: number;
};
type SelectionBookmark = { anchor: Endpoint; focus: Endpoint } | null;
type Patch = { start: number; before: string; after: string; left: string; right: string };
type Transaction = {
  patch: Patch;
  selectionBefore: SelectionBookmark;
  selectionAfter: SelectionBookmark;
};
type PendingTransaction = {
  beforeHTML: string;
  selectionBefore: SelectionBookmark;
  kind: string;
  paragraph: HTMLElement | null;
  timer: number;
};
type EditorOps = { undo: () => void; redo: () => void };

const PARAGRAPH_SELECTOR = "[data-sw-paragraph]";
const HISTORY_BOUNDARY_EVENT = "sw:history:boundary";
const HISTORY_LIMIT = 50;
const TYPING_GROUP_MS = 500;

function paragraphs(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.matches(PARAGRAPH_SELECTOR)
  );
}

function paragraphForNode(root: HTMLElement, node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  const p = el?.closest(PARAGRAPH_SELECTOR) as HTMLElement | null;
  return p?.parentElement === root ? p : null;
}

function pathFrom(root: Node, node: Node): number[] {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return [];
    path.push(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current === root ? path.reverse() : [];
}

function textOffsetIn(paragraph: HTMLElement, node: Node, offset: number): number {
  try {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

function endpointFor(root: HTMLElement, node: Node | null, offset: number): Endpoint | null {
  const all = root.children;
  if (!all.length || !node) return null;

  let p = paragraphForNode(root, node);
  if (!p && node === root) {
    const childIndex = Math.max(0, Math.min(offset, all.length - 1));
    p = (all[childIndex] as HTMLElement | undefined) ?? null;
    if (!p) return null;
    const atEnd = offset >= all.length;
    const endRange = document.createRange();
    endRange.selectNodeContents(p);
    endRange.collapse(!atEnd);
    const pointNode = atEnd ? endRange.startContainer : p;
    const pointOffset = atEnd ? endRange.startOffset : 0;
    return {
      paragraph: childIndex,
      path: pathFrom(p, pointNode),
      nodeType: pointNode.nodeType,
      offset: pointOffset,
      textOffset: atEnd ? (p.textContent || "").length : 0,
    };
  }
  if (!p) return null;

  const index = Array.prototype.indexOf.call(all, p) as number;
  if (index < 0) return null;
  return {
    paragraph: index,
    path: pathFrom(p, node),
    nodeType: node.nodeType,
    offset: Math.max(0, offset),
    textOffset: textOffsetIn(p, node, offset),
  };
}

function captureSelection(root: HTMLElement): SelectionBookmark {
  const selection = window.getSelection?.();
  if (!selection || !selection.rangeCount) return null;
  const anchor = endpointFor(root, selection.anchorNode, selection.anchorOffset);
  const focus = endpointFor(root, selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

function resolveEndpoint(root: HTMLElement, point: Endpoint): { node: Node; offset: number } | null {
  const p = paragraphs(root)[point.paragraph];
  if (!p) return null;

  let node: Node = p;
  let pathValid = true;
  for (const index of point.path) {
    const child = node.childNodes[index];
    if (!child) { pathValid = false; break; }
    node = child;
  }
  if (pathValid && node.nodeType === point.nodeType) {
    const max = node.nodeType === Node.TEXT_NODE
      ? (node.textContent || "").length
      : node.childNodes.length;
    const offset = Math.min(point.offset, max);
    const resolvedTextOffset = node.nodeType === Node.TEXT_NODE
      ? textOffsetIn(p, node, offset)
      : point.textOffset;
    if (resolvedTextOffset === point.textOffset) {
      return { node, offset };
    }
  }

  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let remaining = point.textOffset;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
  }
  return { node: p, offset: 0 };
}

function restoreSelection(root: HTMLElement, bookmark: SelectionBookmark) {
  if (!bookmark) return;
  const anchor = resolveEndpoint(root, bookmark.anchor);
  const focus = resolveEndpoint(root, bookmark.focus);
  const selection = window.getSelection?.();
  if (!anchor || !focus || !selection) return;

  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } catch {
    try {
      selection.collapse(anchor.node, anchor.offset);
      selection.extend(focus.node, focus.offset);
    } catch {
      // Keep the editor content even if a WebView selection cannot be restored.
    }
  }
}

function createPatch(before: string, after: string): Patch | null {
  if (before === after) return null;
  let start = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (start < maxPrefix && before.charCodeAt(start) === after.charCodeAt(start)) start++;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
    beforeEnd--;
    afterEnd--;
  }

  return {
    start,
    before: before.slice(start, beforeEnd),
    after: after.slice(start, afterEnd),
    left: before.slice(Math.max(0, start - 64), start),
    right: before.slice(beforeEnd, Math.min(before.length, beforeEnd + 64)),
  };
}

function applyPatch(current: string, patch: Patch, undo: boolean): string | null {
  const expected = undo ? patch.after : patch.before;
  const replacement = undo ? patch.before : patch.after;
  const matchesAt = (start: number) =>
    start >= 0 &&
    current.slice(start, start + expected.length) === expected &&
    current.slice(Math.max(0, start - patch.left.length), start) === patch.left &&
    current.slice(start + expected.length, start + expected.length + patch.right.length) === patch.right;

  let start = patch.start;
  if (!matchesAt(start)) {
    const candidates: number[] = [];
    const token = expected || patch.right || patch.left;
    if (!token) return null;
    let found = current.indexOf(token);
    while (found >= 0) {
      const candidate = expected
        ? found
        : patch.right
          ? found
          : found + patch.left.length;
      if (matchesAt(candidate)) candidates.push(candidate);
      found = current.indexOf(token, found + 1);
    }
    if (!candidates.length) return null;
    start = candidates.reduce((best, value) =>
      Math.abs(value - patch.start) < Math.abs(best - patch.start) ? value : best
    );
  }
  return current.slice(0, start) + replacement + current.slice(start + expected.length);
}

function coalescingKind(inputType: string): string | null {
  if (inputType === "insertText" || inputType === "insertReplacementText") return "insert";
  if (inputType === "deleteContentBackward") return "backspace";
  if (inputType === "deleteContentForward") return "delete";
  return null;
}

// ---------- Global Undo Arbiter ----------
const ARBITER = (() => {
  const w = window as any;
  if (!w.__SW_UNDO_ARBITER__) {
    const map = new WeakMap<HTMLElement, EditorOps>();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = (e.key || "").toLowerCase();
      if (key !== "z" && key !== "y") return;

      const active = document.activeElement as HTMLElement | null;
      const host = active?.closest?.('[data-sw-editor="1"]') as HTMLElement | null;
      const ops = host ? map.get(host) : undefined;
      if (!ops) return;

      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();
      if (key === "y" || (key === "z" && e.shiftKey)) ops.redo();
      else ops.undo();
    };
    window.addEventListener("keydown", onKey, true);
    w.__SW_UNDO_ARBITER__ = {
      register(el: HTMLElement, ops: EditorOps) { map.set(el, ops); },
      unregister(el: HTMLElement) { map.delete(el); },
    };
  }
  return w.__SW_UNDO_ARBITER__ as {
    register(el: HTMLElement, ops: EditorOps): void;
    unregister(el: HTMLElement): void;
  };
})();

// ---------- Per-editor delta history + curly replacement ----------
export function attachUndoCurly(el: HTMLElement, opts: Opts) {
  const limit = Math.max(1, Math.min(HISTORY_LIMIT, opts.limit ?? HISTORY_LIMIT));
  const hooks = opts.hooks || {};
  const curly = opts.curly;

  let composing = false;
  let lastHTML = el.innerHTML;
  let pending: PendingTransaction | null = null;
  let beforeInputSelection: SelectionBookmark = null;
  let beforeInputParagraph: HTMLElement | null = null;
  let boundarySelection: SelectionBookmark = null;
  let forceNextInput = false;
  let compositionBefore: { html: string; selection: SelectionBookmark } | null = null;
  let compositionCommit: { html: string; selection: SelectionBookmark } | null = null;
  let compositionCommitTimer: number | null = null;
  const undoStack: Transaction[] = [];
  const redoStack: Transaction[] = [];

  const cancelPendingTimer = () => {
    if (pending) window.clearTimeout(pending.timer);
  };

  const record = (beforeHTML: string, selectionBefore: SelectionBookmark) => {
    const afterHTML = el.innerHTML;
    const patch = createPatch(beforeHTML, afterHTML);
    lastHTML = afterHTML;
    if (!patch) return;

    undoStack.push({
      patch,
      selectionBefore,
      selectionAfter: captureSelection(el),
    });
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    hooks.scheduleSave?.();
  };

  const flushComposition = () => {
    if (compositionCommitTimer !== null) {
      window.clearTimeout(compositionCommitTimer);
      compositionCommitTimer = null;
    }
    const item = compositionCommit;
    compositionCommit = null;
    if (item) record(item.html, item.selection);
  };

  const commitPending = () => {
    if (!pending) return;
    const item = pending;
    pending = null;
    window.clearTimeout(item.timer);
    record(item.beforeHTML, item.selectionBefore);
  };

  const recordCurrent = (selectionBefore: SelectionBookmark) => {
    commitPending();
    record(lastHTML, selectionBefore);
  };

  const onHistoryBoundary = () => {
    flushComposition();
    commitPending();
    boundarySelection = captureSelection(el);
    forceNextInput = true;
  };

  const beforeinput = (event: InputEvent) => {
    const inputType = event.inputType || "";
    const curlyConfig = typeof curly === "function" ? curly() : curly;
    const data = (event as any).data as string | undefined;
    const isCurlyReplacementInput = !!curlyConfig?.enabled
      && inputType === "insertText"
      && (data === "{" || data === "}")
      && !(event as any).isComposing;

    // Keep IME composition edits untouched, but don't let the zero-delay
    // composition-history flush swallow a regular brace typed immediately
    // after compositionend (common with Korean IMEs).
    if (composing || (event as any).isComposing) return;
    if (compositionCommit) {
      if (!isCurlyReplacementInput) return;
      flushComposition();
    }

    const group = coalescingKind(inputType);
    const liveSelection = window.getSelection?.();
    const isCollapsed = liveSelection?.isCollapsed ?? true;
    const paragraph = paragraphForNode(el, liveSelection?.anchorNode ?? null);
    const continuesPending = !!pending && !!group && pending.kind === group &&
      pending.paragraph === paragraph && isCollapsed;

    if (pending && !continuesPending) commitPending();
    beforeInputParagraph = paragraph;
    beforeInputSelection = continuesPending ? null : captureSelection(el);

    if (inputType === "insertParagraph") {
      commitPending();
      const before = lastHTML;
      const beforeSelection = boundarySelection ?? beforeInputSelection;
      boundarySelection = null;
      forceNextInput = false;
      window.setTimeout(() => record(before, beforeSelection), 0);
    }

    if (isCurlyReplacementInput && curlyConfig) {
      event.preventDefault();
      commitPending();
      const before = lastHTML;
      const beforeSelection = beforeInputSelection;
      try {
        const replacement = data === "{" ? curlyConfig.map.left : curlyConfig.map.right;
        document.execCommand("insertText", false, replacement);
      } catch {}
      commitPending();
      record(before, beforeSelection);
    }
  };

  const input = (event: InputEvent) => {
    if (composing || compositionCommit) return;
    const inputType = event.inputType || "";
    let selectionBefore = boundarySelection ?? beforeInputSelection;
    beforeInputSelection = null;

    if (forceNextInput) {
      forceNextInput = false;
      boundarySelection = null;
      recordCurrent(selectionBefore ?? captureSelection(el));
      return;
    }

    const group = coalescingKind(inputType);
    if (!group) {
      recordCurrent(selectionBefore ?? captureSelection(el));
      return;
    }

    const liveSelection = window.getSelection?.();
    const paragraph = beforeInputParagraph ?? paragraphForNode(el, liveSelection?.focusNode ?? null);
    beforeInputParagraph = null;
    if (pending && (pending.kind !== group || pending.paragraph !== paragraph)) commitPending();
    if (!pending) {
      selectionBefore ??= captureSelection(el);
      pending = {
        beforeHTML: lastHTML,
        selectionBefore,
        kind: group,
        paragraph,
        timer: 0,
      };
    }
    cancelPendingTimer();
    pending.timer = window.setTimeout(commitPending, TYPING_GROUP_MS);
  };

  const paste = () => {
    const before = boundarySelection ?? captureSelection(el);
    flushComposition();
    commitPending();
    forceNextInput = false;
    boundarySelection = null;
    window.setTimeout(() => recordCurrent(before), 0);
  };

  const cut = () => {
    if (!window.getSelection?.()?.isCollapsed) onHistoryBoundary();
  };
  const compositionstart = () => {
    flushComposition();
    commitPending();
    beforeInputSelection = null;
    beforeInputParagraph = null;
    composing = true;
    compositionBefore = { html: lastHTML, selection: captureSelection(el) };
  };
  const compositionend = () => {
    composing = false;
    compositionCommit = compositionBefore || { html: lastHTML, selection: captureSelection(el) };
    compositionBefore = null;
    compositionCommitTimer = window.setTimeout(flushComposition, 0);
  };

  const undo = () => {
    flushComposition();
    commitPending();
    const transaction = undoStack[undoStack.length - 1];
    if (!transaction) return;
    const html = applyPatch(el.innerHTML, transaction.patch, true);
    if (html === null) return;
    undoStack.pop();
    redoStack.push(transaction);
    el.innerHTML = html;
    lastHTML = html;
    restoreSelection(el, transaction.selectionBefore);
    hooks.onChange?.(html);
    hooks.scheduleSave?.();
  };

  const redo = () => {
    flushComposition();
    commitPending();
    const transaction = redoStack[redoStack.length - 1];
    if (!transaction) return;
    const html = applyPatch(el.innerHTML, transaction.patch, false);
    if (html === null) return;
    redoStack.pop();
    undoStack.push(transaction);
    el.innerHTML = html;
    lastHTML = html;
    restoreSelection(el, transaction.selectionAfter);
    hooks.onChange?.(html);
    hooks.scheduleSave?.();
  };

  el.addEventListener(HISTORY_BOUNDARY_EVENT, onHistoryBoundary as EventListener, true);
  el.addEventListener("beforeinput", beforeinput as EventListener, true);
  el.addEventListener("input", input as EventListener, true);
  el.addEventListener("paste", paste as EventListener, true);
  el.addEventListener("cut", cut as EventListener, true);
  el.addEventListener("compositionstart", compositionstart, true);
  el.addEventListener("compositionend", compositionend, true);

  ARBITER.register(el, { undo, redo });

  return {
    undo,
    redo,
    destroy() {
      cancelPendingTimer();
      if (compositionCommitTimer !== null) window.clearTimeout(compositionCommitTimer);
      el.removeEventListener(HISTORY_BOUNDARY_EVENT, onHistoryBoundary as EventListener, true);
      el.removeEventListener("beforeinput", beforeinput as EventListener, true);
      el.removeEventListener("input", input as EventListener, true);
      el.removeEventListener("paste", paste as EventListener, true);
      el.removeEventListener("cut", cut as EventListener, true);
      el.removeEventListener("compositionstart", compositionstart, true);
      el.removeEventListener("compositionend", compositionend, true);
      ARBITER.unregister(el);
    },
  };
}
