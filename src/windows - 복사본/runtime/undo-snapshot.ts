// src/windows/runtime/undo-snapshot.ts
export type CurlyConfig = {
  enabled: boolean;
  map: { left: string; right: string };
};

type Hooks = { scheduleSave?: () => void };

type Opts = {
  boardId: string;
  limit?: number;          // default 20
  curly?: CurlyConfig;
  hooks?: Hooks;
};

type Snapshot = string;
type EditorOps = { undo: () => void; redo: () => void };

// ---------- Global Undo Arbiter (window capture 우선 차단) ----------
const ARBITER = (() => {
  const w = window as any;
  if (!w.__SW_UNDO_ARBITER__) {
    const map = new WeakMap<HTMLElement, EditorOps>();

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || e.altKey) return;

      const k = (e.key || "").toLowerCase();
      if (k !== "z" && k !== "y") return;

      const ae = (document.activeElement as HTMLElement) || null;
      const host = ae && ae.closest?.('[data-sw-editor="1"]') as HTMLElement | null;
      if (!host) return;

      const ops = map.get(host);
      if (!ops) return;

      // 여기서 바로 처리하고 전파를 완전히 차단
      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();

      if (k === "y" || (k === "z" && e.shiftKey)) ops.redo();
      else ops.undo();
    };

    window.addEventListener("keydown", onKey, true); // ★ 최상단 capture

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

// ---------- Per-editor snapshot + curly ----------
export function attachUndoCurly(el: HTMLElement, opts: Opts) {
  const limit = Math.max(1, opts.limit ?? 20);
  const hooks = opts.hooks || {};
  const curly = opts.curly;

  let composing = false;
  let undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let lastHTML: string = el.innerHTML;

  const take = () => el.innerHTML;
  const differentFromLast = (html: string) => html !== lastHTML;
  const restore = (html: string) => {
    el.innerHTML = html || "";
    placeCaretAtEnd(el);
    lastHTML = el.innerHTML;
    hooks.scheduleSave?.();
  };

  function pushSnapshot(reason?: string) {
    const now = take();
    if (!differentFromLast(now)) return;
    undoStack.push(lastHTML);
    if (undoStack.length > limit) undoStack.shift();
    lastHTML = now;
    redoStack = [];
    hooks.scheduleSave?.();
  }

  function undo() {
    if (composing || !undoStack.length) return;
    const prev = undoStack.pop()!;
    const curr = take();
    redoStack.push(curr);
    restore(prev);
  }

  function redo() {
    if (composing || !redoStack.length) return;
    const next = redoStack.pop()!;
    const curr = take();
    undoStack.push(curr);
    restore(next);
  }

  // caret 보정: 끝으로
  function placeCaretAtEnd(root: HTMLElement) {
    root.focus?.();
    const sel = window.getSelection?.();
    if (!sel) return;
    const r = document.createRange();
    let target: Node = root.lastChild || root;
    if (target.nodeType === 1) {
      r.selectNodeContents(target as HTMLElement);
      r.collapse(false);
    } else {
      r.setStartAfter(target);
      r.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // --- inputs / boundaries ---
  let debounceTimer: number | null = null;
  const DEBOUNCE_MS = 250;

  const scheduleDebouncedSnap = () => {
    if (composing) return;
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      pushSnapshot("typing");
      debounceTimer = null;
    }, DEBOUNCE_MS);
  };

  const beforeinput = (e: InputEvent) => {
    if (composing) return;

    // 실시간 { } 치환
    if (curly?.enabled && e.inputType === "insertText") {
      const data = (e as any).data as string | undefined;
      if (data === "{" || data === "}") {
        e.preventDefault();
        try {
          const rep = data === "{" ? curly.map.left : curly.map.right;
          document.execCommand("insertText", false, rep);
        } catch {}
        pushSnapshot("curly");
        return;
      }
    }

    // 줄바꿈은 즉시 스냅샷 경계
    if (e.inputType === "insertParagraph") {
      setTimeout(() => pushSnapshot("paragraph"), 0);
      return;
    }
  };

  const input = (_e: InputEvent) => {
    if (!composing) scheduleDebouncedSnap();
  };

  const paste = (_e: ClipboardEvent) => {
    setTimeout(() => pushSnapshot("paste"), 0);
  };

  const compositionstart = () => { composing = true; };
  const compositionend   = () => { composing = false; pushSnapshot("ime-end"); };

  lastHTML = take();

  el.addEventListener("beforeinput", beforeinput as any, true);
  el.addEventListener("input", input as any, true);
  el.addEventListener("paste", paste as any, true);
  el.addEventListener("compositionstart", compositionstart as any, true);
  el.addEventListener("compositionend", compositionend as any, true);

  // 전역 중재자에 현재 보드 등록
  ARBITER.register(el, { undo, redo });

  return {
    undo, redo, // 필요시 외부에서 직접 호출도 가능
    destroy() {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      el.removeEventListener("beforeinput", beforeinput as any, true);
      el.removeEventListener("input", input as any, true);
      el.removeEventListener("paste", paste as any, true);
      el.removeEventListener("compositionstart", compositionstart as any, true);
      el.removeEventListener("compositionend", compositionend as any, true);
      ARBITER.unregister(el);
    },
  };
}
