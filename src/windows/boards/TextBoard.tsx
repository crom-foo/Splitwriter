// src/windows/boards/TextBoard.tsx
import React, {
  useEffect, useRef, forwardRef, useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import WindowResizeEdges from "../ui/WindowResizeEdges";
import TextToolbar, { TOOLBAR_H } from "../ui/TextToolbar";
import { attachUndoCurly } from "../runtime/undo-snapshot";
import { normalizeCurly, type CurlyPref } from "../runtime/curly";
import { useWritingGoal } from "../runtime/writingGoal";
import EchoReader from "../ui/EchoView";

export type Preset = 1 | 2 | 3 | 4;

export type TextBoardHandle = {
  focus: () => void;
  applyPreset: (p: Preset) => void;
  align: (k: "left" | "center" | "right" | "justify") => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  getHTML: () => string;
  setHTML: (html: string) => void;
  getText: () => string;
  // MainUI bridge: Typewriter/Spellcheck ON/OFF
  setTypewriter: (on: boolean) => void;
  setSpellcheck: (on: boolean) => void;
  getTypewriter: () => boolean;
  getSpellcheck: () => boolean;
  getPlainText: () => string;
};

type Props = {
  id: string;

  // Other props currently in use (compatibility)
  className?: string;
  initialHTML?: string;
  /** @deprecated unused; kept for external compatibility */
  onPresetChange?: (p: Preset) => void; 
  scheduleSave?: () => void;
  curly?: CurlyPref;
  onChange?: (html: string) => void;

  // Other optional props passed by MainUI (type-compat only)
  color?: string;
  inset?: any;
  /** @deprecated unused */
  preset?: Preset;
  /** @deprecated unused */
  presetSeq?: number;
  typefaces?: any;
  onHUDChange?: (s: any) => void;
  writingGoal?: {
    enabled: boolean;
    mode: "words" | "chars";
    target: number;
    current: number;
    format?: string;
    quietColor?: string;
    hitColor?: string;
  };
};

const PSEL = "[data-sw-paragraph]";

/* ---------- Preset helpers ---------- */
const getPresetOf = (el: HTMLElement | null): Preset => {
  if (!el) return 2;
  const hit = Array.from(el.classList).find((c) => /^sw-preset-[1-4]$/.test(c));
  return (hit ? Number(hit.slice(-1)) : 2) as Preset;
};
const closestParagraph = (n: Node | null): HTMLElement | null => {
  if (!n) return null;
  const el = (n.nodeType === 1 ? (n as HTMLElement) : (n.parentElement as HTMLElement)) || null;
  return el ? (el.closest(PSEL) as HTMLElement | null) : null;
};

/* ---------- TopBar HUD bridge: custom event only ---------- */
function emitHud(detail: Partial<{ preset: Preset; bold: boolean; italic: boolean }>) {
  try {
    const ev = new CustomEvent("sw:hud", { detail, bubbles: false, composed: false, cancelable: false });
    window.dispatchEvent(ev);
  } catch {}
}

/* ---------- Paragraph marker enforcement ---------- */
function ensureParagraphMarkers(ed: HTMLElement) {
  Array.from(ed.childNodes).forEach((n) => {
    if (n.nodeType === 1) {
      const el = n as HTMLElement;
      if (!el.hasAttribute("data-sw-paragraph")) el.setAttribute("data-sw-paragraph", "1");
      if (!/sw-preset-\d/.test(el.className)) el.classList.add("sw-preset-2");
    } else if (n.nodeType === 3 && (n.textContent || "").trim() !== "") {
      const p = document.createElement("p");
      p.setAttribute("data-sw-paragraph", "1");
      p.classList.add("sw-preset-2");
      p.textContent = n.textContent || "";
      ed.insertBefore(p, n);
      n.parentNode?.removeChild(n);
    }
  });

  if (!ed.querySelector(PSEL)) {
    const p = document.createElement("p");
    p.setAttribute("data-sw-paragraph", "1");
    p.classList.add("sw-preset-2");
    p.appendChild(document.createElement("br"));
    ed.appendChild(p);
  }
}

function ensureParagraphMarkersNearCaret(ed: HTMLElement) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) { ensureParagraphMarkers(ed); return; }

  const fix = (el: HTMLElement | null) => {
    if (!el) return;
    if (!el.hasAttribute("data-sw-paragraph")) el.setAttribute("data-sw-paragraph", "1");
    if (!/sw-preset-\d/.test(el.className)) el.classList.add("sw-preset-2");
  };

  const base = sel.getRangeAt(0).startContainer;
  let curP = closestParagraph(base);
  // If caret is in a bare text node outside a paragraph, wrap that node with <p>
  if (!curP && base && base.nodeType === 3 && (base.nodeValue || "").trim() !== "") {
    const p = document.createElement("p");
    p.setAttribute("data-sw-paragraph", "1");
    p.classList.add("sw-preset-2");
    base.parentNode?.insertBefore(p, base);
    p.appendChild(base);
    curP = p;
  }

  // Strengthen current paragraph and its adjacent siblings only
  const target = curP || (ed.querySelector(PSEL) as HTMLElement | null);
  fix(target as HTMLElement | null);

  const sibs = [target?.previousSibling, target?.nextSibling];
  for (const s of sibs) {
    if (!s) continue;
    if (s.nodeType === 1) fix(s as HTMLElement);
    else if (s.nodeType === 3 && (s.textContent || "").trim() !== "") {
      const p = document.createElement("p");
      p.setAttribute("data-sw-paragraph", "1");
      p.classList.add("sw-preset-2");
      p.textContent = s.textContent || "";
      ed.insertBefore(p, s);
      s.parentNode?.removeChild(s);
    }
  }

  // Safety: ensure at least one paragraph exists
  if (!ed.querySelector(PSEL)) {
    const p = document.createElement("p");
    p.setAttribute("data-sw-paragraph", "1");
    p.classList.add("sw-preset-2");
    p.appendChild(document.createElement("br"));
    ed.appendChild(p);
  }
}

function selectionRangeIn(ed: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  return ed.contains(r.startContainer) ? r : null;
}
function isEventInsideEditor(ed: HTMLElement): boolean {
  const active = document.activeElement;
  return !!(active && ed.contains(active));
}
function paragraphsInSelection(ed: HTMLElement): HTMLElement[] {
  const r = selectionRangeIn(ed);
  const paras = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));
  if (!paras.length) return [];
  if (!r) return [paras[0]];
  if (r.collapsed) {
    const base = (r.startContainer.nodeType === 1
      ? (r.startContainer as HTMLElement)
      : (r.startContainer.parentElement as HTMLElement));
    const p = base?.closest(PSEL) as HTMLElement | null;
    return p ? [p] : [paras[0]];
  }
  const out: HTMLElement[] = [];
  for (const p of paras) {
    const pr = document.createRange();
    pr.selectNodeContents(p);
    const endsBeforeStart = pr.compareBoundaryPoints(Range.END_TO_START, r) <= 0;
    const startsAfterEnd  = pr.compareBoundaryPoints(Range.START_TO_END,  r) >= 0;
    if (!(endsBeforeStart || startsAfterEnd)) out.push(p);
  }
  return out.length ? out : [paras[0]];
}

function applyPresetToParagraph(p: HTMLElement, preset: Preset) {
  p.classList.remove("sw-preset-1", "sw-preset-2", "sw-preset-3", "sw-preset-4");
  p.classList.add(`sw-preset-${preset}`);

  const walker = document.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as HTMLElement | null; n; n = walker.nextNode() as HTMLElement | null) {
    if (n === p) continue;
    const st = n.style;
    st.removeProperty("font");
    st.removeProperty("font-size");
    st.removeProperty("line-height");
    st.removeProperty("font-family");
  }
}

function placeCaretAtEnd(ed: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const lastP = ed.querySelector(`${PSEL}:last-of-type`) as HTMLElement | null;
  const r = document.createRange();
  if (lastP) r.selectNodeContents(lastP);
  else r.selectNodeContents(ed);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function fragmentToPlainText(frag: DocumentFragment): string {
  let out = "";

  const walk = (n: Node) => {
    if (n.nodeType === 3) {            
      out += (n.nodeValue || "");
      return;
    }
    if (n.nodeType !== 1) return;

    const el = n as HTMLElement;
    if (el.tagName === "BR") {  
      out += "\n";
      return;
    }

    const isPara = el.matches?.(PSEL) ?? false;
    // children
    for (const ch of Array.from(el.childNodes)) walk(ch);
    if (isPara) out += "\n\n";
  };

  for (const ch of Array.from(frag.childNodes)) walk(ch);

  return out
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // Keep leading spaces/tabs intact: Splitwriter should preserve author intent.
    .replace(/^\n+|\n+$/g, "");
}

// === Ellipsis ===
const ELLIPSIS_STR = "…"; // If you prefer three dots, change to "..."

function insertEllipsisAtSelection(root: HTMLElement, schedule?: () => void, onChange?: (h: string)=>void, onNudge?: ()=>void) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);

  try {
    if (document.queryCommandSupported?.("insertText")) {
      document.execCommand("insertText", false, ELLIPSIS_STR);
    } else {
      r.deleteContents();
      const tn = document.createTextNode(ELLIPSIS_STR);
      r.insertNode(tn);
      r.setStartAfter(tn);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {
    r.deleteContents();
    const tn = document.createTextNode(ELLIPSIS_STR);
    r.insertNode(tn);
    r.setStartAfter(tn);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  schedule?.();
  onChange?.(root.innerHTML);
  onNudge?.(); // If typewriter is ON, adjust scroll position
}

// === Tab input ===
// Store a real tab character, and let CSS control how wide it looks.
const TAB_STR = "\t";

function insertRawTextAtSelection(root: HTMLElement, text: string, schedule?: () => void, onChange?: (h: string)=>void, onNudge?: ()=>void) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return;

  let done = false;
  try {
    if (document.queryCommandSupported?.("insertText")) {
      done = !!document.execCommand("insertText", false, text);
    }
  } catch {
    done = false;
  }

  if (!done) {
    r.deleteContents();
    const tn = document.createTextNode(text);
    r.insertNode(tn);
    r.setStartAfter(tn);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  ensureParagraphMarkersNearCaret(root);
  schedule?.();
  onChange?.(root.innerHTML);
  onNudge?.();
}

function textOffsetBeforeNode(root: HTMLElement, node: Node): number {
  try {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, 0);
    return r.toString().length;
  } catch {
    return 0;
  }
}

function removeLeadingTabFromParagraph(p: HTMLElement): boolean {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.data.length) continue;
    if (t.data.startsWith(TAB_STR)) {
      t.deleteData(0, TAB_STR.length);
      return true;
    }
    return false;
  }
  return false;
}

type Inset = { top?: number; left?: number };

function getStyles(opts: { color?: string; inset?: Inset; toolbarH: number }) {
  const { color, inset, toolbarH } = opts;
  const topBase = inset?.top ?? 0;

  return {
    wrap: {
      position: "absolute" as const,
      inset: 0,
      zIndex: 10, // textboard layer
      paddingTop: `calc(${topBase + toolbarH + 1}px + var(--pad-top, 20px))`,
      paddingLeft: inset?.left ?? 0,
      color,
    },
    toolbarBox: {
      position: "absolute" as const,
      top: topBase,
      left: (inset?.left ?? 0) + 8,
      right: 10,
      zIndex: 10000,
      isolation: "isolate" as const,
      pointerEvents: "auto" as const,
    },
    divider: {
      position: "absolute" as const,
      top: topBase + toolbarH,
      left: 6,
      right: 6,
      height: 1,
      background: "var(--divider, rgba(255,255,255,0.08))",
      zIndex: 11,
    },
    editorWrap: {
      position: "absolute" as const,
      top:        `calc(${topBase + toolbarH + 1}px + var(--pad-top, 20px))`,
      left: inset?.left ?? 0,
      right: 0,
      bottom: 0,
      overflow: "auto" as const,
      scrollBehavior: "auto" as any,
      willChange: "scroll-position",
      contain: "layout paint",
      overflowAnchor: "none" as any,
      overscrollBehavior: "contain" as any,
    },
    editorCol: {
      position: "relative" as const,
      width: "var(--col-width-pct, 94%)",
      maxWidth: "var(--content-max, 820px)",
      margin: "0 auto",
      padding:    "var(--pad-y, 18px) var(--pad-x, 24px)",
      transition: "none",
      willChange: "width,left",
      overflowAnchor: "none" as any, 
    },
  };
}

// ----- Echo background URL resolution (path → convertFileSrc, etc.) -----
async function resolveEchoBgUrl(raw: string | null): Promise<string | undefined> {
  if (!raw) return undefined;

  // Schemes the browser can use directly
  if (/^(blob:|data:|https?:|asset:|tauri:|app:)/i.test(raw)) return raw;

  // file:// → decode to OS path then convert (Tauri)
  if (/^file:\/\//i.test(raw)) {
    try {
      let p = decodeURI(raw.replace(/^file:\/\//i, ""));
      if (/^[A-Za-z]:\//.test(p)) p = p.replace(/\//g, "\\"); // C:/ → C:\
      if ((window as any).__TAURI_IPC__) {
        const { convertFileSrc } = await import("@tauri-apps/api/tauri");
        return convertFileSrc(p);
      }
      return undefined;
    } catch { return undefined; }
  }

  // If it looks like a path (Tauri only), use convertFileSrc
  if (/^[A-Za-z]:[\\/]|^\\\\|^\//.test(raw)) {
    if ((window as any).__TAURI_IPC__) {
      const { convertFileSrc } = await import("@tauri-apps/api/tauri");
      return convertFileSrc(raw);
    }
    return undefined;
  }

  // Otherwise, try as-is
  return raw;
}

/* ─────────────────────────────────────────────
   Echo tokenization helpers (caret → startAt)
   ───────────────────────────────────────────── */
const END_PUNCT = /[\.!?…]+/;
const CLOSERS = `”’"'\\)\\]\\}〉》」『】>`;
function tokenCountOfParagraphText(src: string): number {
  const text = (src || "").replace(/\r\n/g, "\n").replace(/\t/g, " ").trim();
  if (!text) return 0;
  const re = new RegExp(`(.+?${END_PUNCT.source}(?:[${CLOSERS}])?)`, "g");
  let cnt = 0, m: RegExpExecArray | null, last = 0;
  while ((m = re.exec(text)) !== null) { cnt++; last = re.lastIndex; }
  const rest = text.slice(last).trim(); if (rest) cnt++;
  return cnt;
}
function countEndedBefore(paraText: string, caretOff: number): number {
  const text = (paraText || "");
  const re = new RegExp(`(.+?${END_PUNCT.source}(?:[${CLOSERS}])?)`, "g");
  let cnt = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = re.lastIndex;
    if (end <= caretOff) cnt++; else break;
  }
  return cnt;
}



/* ─────────────────────────────────────────────
   Strict paragraph model TEST helpers
   Rule: editor root children must be only <p data-sw-paragraph> nodes.
   A visible line/paragraph is one data-sw-paragraph node; <br> is allowed
   only as an empty-paragraph placeholder.
   ───────────────────────────────────────────── */
function strictTextOffsets(root: HTMLElement, sel: Selection | null): { start: number; end: number } | null {
  if (!root || !sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let start = 0, end = 0, pos = 0;
  let gotS = false, gotE = false;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.data.length;
    if (!gotS && r.startContainer === t) { start = pos + r.startOffset; gotS = true; }
    if (!gotE && r.endContainer === t) { end = pos + r.endOffset; gotE = true; }
    pos += len;
  }

  // Element-boundary selections are common around empty paragraphs.
  if (!gotS || !gotE) {
    try {
      const pre = document.createRange();
      pre.setStart(root, 0);
      pre.setEnd(r.startContainer, Math.min(r.startOffset, (r.startContainer as any).length ?? r.startOffset));
      const s = pre.toString().length;
      const pre2 = document.createRange();
      pre2.setStart(root, 0);
      pre2.setEnd(r.endContainer, Math.min(r.endOffset, (r.endContainer as any).length ?? r.endOffset));
      const e = pre2.toString().length;
      return { start: s, end: e };
    } catch {
      return { start: pos, end: pos };
    }
  }
  return { start, end };
}

function restoreStrictTextOffsets(root: HTMLElement, start: number, end: number) {
  const sel = window.getSelection?.();
  if (!sel) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0, sNode: Text | null = null, eNode: Text | null = null;
  let sOff = 0, eOff = 0;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.data.length;
    if (!sNode && start <= pos + len) { sNode = t; sOff = Math.max(0, Math.min(len, start - pos)); }
    if (!eNode && end <= pos + len) { eNode = t; eOff = Math.max(0, Math.min(len, end - pos)); break; }
    pos += len;
  }

  const r = document.createRange();
  if (!sNode) {
    const firstP = root.querySelector(PSEL) as HTMLElement | null;
    if (firstP) r.setStart(firstP, 0);
    else r.setStart(root, 0);
    r.collapse(true);
  } else if (!eNode) {
    r.setStart(sNode, sOff);
    r.collapse(true);
  } else {
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

function strictAlignOf(el?: HTMLElement | null): "left" | "center" | "right" | "justify" {
  const v = (el?.style?.textAlign || "").toLowerCase();
  return v === "left" || v === "center" || v === "right" || v === "justify" ? (v as any) : "justify";
}

function strictHasMeaningfulContent(n: Node): boolean {
  if (n.nodeType === 3) return (n.textContent || "").length > 0;
  if (n.nodeType === 11) return Array.from(n.childNodes).some(strictHasMeaningfulContent);
  if (n.nodeType !== 1) return false;
  const el = n as HTMLElement;
  if (el.tagName === "BR") return false;
  return (el.textContent || "").length > 0 || Array.from(el.childNodes).some(strictHasMeaningfulContent);
}

function stripUnsafeCloneAttrs(el: HTMLElement) {
  el.removeAttribute("contenteditable");
  el.removeAttribute("data-sw-paragraph");
  el.removeAttribute("data-sw-editor");
  el.removeAttribute("data-role");
  el.removeAttribute("spellcheck");
}

function splitNodesToLineFragments(nodes: NodeListOf<ChildNode> | ChildNode[]): DocumentFragment[] {
  const lines: DocumentFragment[] = [document.createDocumentFragment()];
  const current = () => lines[lines.length - 1];
  const newLine = () => lines.push(document.createDocumentFragment());

  const appendText = (s: string) => {
    const parts = String(s || "").replace(/\r\n?/g, "\n").split("\n");
    parts.forEach((part, i) => {
      if (i > 0) newLine();
      if (part.length) current().appendChild(document.createTextNode(part));
    });
  };

  const appendFragmentMoved = (frag: DocumentFragment, target: Node) => {
    while (frag.firstChild) target.appendChild(frag.firstChild);
  };

  const appendInlineElement = (el: HTMLElement) => {
    const parts = splitNodesToLineFragments(Array.from(el.childNodes) as ChildNode[]);
    parts.forEach((part, i) => {
      if (i > 0) newLine();
      if (!strictHasMeaningfulContent(part)) return;
      const shell = el.cloneNode(false) as HTMLElement;
      stripUnsafeCloneAttrs(shell);
      appendFragmentMoved(part, shell);
      current().appendChild(shell);
    });
  };

  const appendBlockElement = (el: HTMLElement) => {
    const parts = splitNodesToLineFragments(Array.from(el.childNodes) as ChildNode[]);
    parts.forEach((part, i) => {
      if (i > 0 || strictHasMeaningfulContent(current())) newLine();
      appendFragmentMoved(part, current());
    });
    // A nested block represents a real paragraph boundary.
    if (strictHasMeaningfulContent(current())) newLine();
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) { appendText(node.nodeValue || ""); return; }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") { newLine(); return; }
    if (el.matches(PSEL) || tag === "P" || tag === "DIV") { appendBlockElement(el); return; }
    appendInlineElement(el);
  };

  Array.from(nodes as any).forEach(walk);

  // Trim only trailing empty fragments created by block boundaries; preserve intentional blanks inside.
  while (lines.length > 1 && !strictHasMeaningfulContent(lines[lines.length - 1])) lines.pop();
  return lines;
}

function makeStrictParagraphFromFragment(
  frag: DocumentFragment,
  preset: Preset = 2,
  align: "left" | "center" | "right" | "justify" = "justify"
): HTMLParagraphElement {
  const p = document.createElement("p");
  p.setAttribute("data-sw-paragraph", "1");
  p.classList.add(`sw-preset-${preset}`);
  p.style.textAlign = align;
  if (strictHasMeaningfulContent(frag)) p.appendChild(frag);
  else p.appendChild(document.createElement("br"));
  return p;
}

function makeStrictTextParagraph(
  text: string,
  preset: Preset = 2,
  align: "left" | "center" | "right" | "justify" = "justify"
): HTMLParagraphElement {
  const frag = document.createDocumentFragment();
  if (text.length) frag.appendChild(document.createTextNode(text));
  return makeStrictParagraphFromFragment(frag, preset, align);
}

function removePlaceholderBR(p: HTMLElement) {
  if (p.childNodes.length === 1 && p.firstChild?.nodeName === "BR") p.textContent = "";
}

function ensureParagraphNotVisuallyEmpty(p: HTMLElement) {
  if (!strictHasMeaningfulContent(p)) {
    p.textContent = "";
    p.appendChild(document.createElement("br"));
  }
}

function editorNeedsStrictParagraphNormalize(ed: HTMLElement): boolean {
  if (!ed.querySelector(PSEL)) return true;
  for (const n of Array.from(ed.childNodes)) {
    if (n.nodeType === 3 && (n.textContent || "").length > 0) return true;
    if (n.nodeType !== 1) continue;
    const el = n as HTMLElement;
    if (el.tagName === "BR") return true;
    if (!el.matches(PSEL)) return true;
    if (el.querySelector("p,div,[data-sw-paragraph]")) return true;
    const brs = Array.from(el.querySelectorAll("br"));
    if (brs.length > 1) return true;
    if (brs.length === 1 && ((el.textContent || "").length > 0 || el.childNodes.length > 1)) return true;
  }
  return false;
}

function normalizeEditorParagraphsStrict(ed: HTMLElement, opts: { preserveSelection?: boolean } = {}): boolean {
  const saved = opts.preserveSelection ? strictTextOffsets(ed, window.getSelection?.() || null) : null;
  const paras: HTMLElement[] = [];

  const addLines = (lines: DocumentFragment[], preset: Preset, align: "left" | "center" | "right" | "justify") => {
    for (const line of lines) paras.push(makeStrictParagraphFromFragment(line, preset, align));
  };

  for (const node of Array.from(ed.childNodes)) {
    if (node.nodeType === 3) {
      const lines = splitNodesToLineFragments([node as ChildNode]);
      addLines(lines, 2, "justify");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      paras.push(makeStrictTextParagraph("", 2, "justify"));
      continue;
    }
    const preset = getPresetOf(el.matches(PSEL) ? el : closestParagraph(el));
    const align = strictAlignOf(el);
    const lines = splitNodesToLineFragments(Array.from(el.childNodes) as ChildNode[]);
    addLines(lines.length ? lines : [document.createDocumentFragment()], preset, align);
  }

  if (!paras.length) paras.push(makeStrictTextParagraph("", 2, "justify"));
  ed.replaceChildren(...paras);

  if (saved) {
    restoreStrictTextOffsets(ed, saved.start, saved.end);
    try { ed.focus({ preventScroll: true } as any); } catch {}
  }
  return true;
}

function setCaretWithMarker(marker: Node) {
  const sel = window.getSelection?.();
  const parent = marker.parentNode as HTMLElement | null;
  if (!sel || !parent) return;
  const r = document.createRange();
  r.setStartBefore(marker);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  marker.parentNode?.removeChild(marker);
  if (parent.matches?.(PSEL)) ensureParagraphNotVisuallyEmpty(parent);
}

function setCaretInParagraphTextOffset(p: HTMLElement, offset: number) {
  const sel = window.getSelection?.();
  if (!sel) return;

  const want = Math.max(0, Number(offset) || 0);
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let target: Text | null = null;
  let targetOff = 0;

  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.data.length;
    if (want <= pos + len) {
      target = t;
      targetOff = Math.max(0, Math.min(len, want - pos));
      break;
    }
    pos += len;
  }

  if (!target) {
    // Empty paragraphs and element-boundary ranges are fragile in WebView/contentEditable.
    // Keep an empty text node as a stable caret anchor before the placeholder <br>.
    target = document.createTextNode("");
    const br = Array.from(p.childNodes).find(n => n.nodeName === "BR") || null;
    p.insertBefore(target, br);
    targetOff = 0;
  }

  const r = document.createRange();
  r.setStart(target, targetOff);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}


function makeRangeInParagraphTextOffset(p: HTMLElement, offset: number): Range | null {
  const want = Math.max(0, Number(offset) || 0);
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let target: Text | null = null;
  let targetOff = 0;

  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.data.length;
    if (want <= pos + len) {
      target = t;
      targetOff = Math.max(0, Math.min(len, want - pos));
      break;
    }
    pos += len;
  }

  if (!target) {
    target = document.createTextNode("");
    const br = Array.from(p.childNodes).find(n => n.nodeName === "BR") || null;
    p.insertBefore(target, br);
    targetOff = 0;
  }

  const r = document.createRange();
  r.setStart(target, targetOff);
  r.collapse(true);
  return r;
}

function placeCaretFromPointInEditor(ed: HTMLElement, x: number, y: number): boolean {
  const sel = window.getSelection?.();
  if (!sel || !ed) return false;

  let r: Range | null = null;
  try {
    const docAny = document as any;
    if (typeof docAny.caretRangeFromPoint === "function") {
      r = docAny.caretRangeFromPoint(x, y) as Range | null;
    } else if (typeof docAny.caretPositionFromPoint === "function") {
      const pos = docAny.caretPositionFromPoint(x, y);
      if (pos?.offsetNode) {
        r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset || 0);
        r.collapse(true);
      }
    }
  } catch {
    r = null;
  }

  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const hitP = hit?.closest?.(PSEL) as HTMLElement | null;

  // WebView sometimes returns the editor root boundary instead of the text node.
  // Accept point ranges only when they resolve to a real paragraph.
  if (!r || !ed.contains(r.startContainer) || !closestParagraph(r.startContainer)) {
    if (!hitP || !ed.contains(hitP)) return false;
    const rect = hitP.getBoundingClientRect();
    const textLen = (hitP.textContent || "").length;
    const edgeOffset = x > rect.left + rect.width / 2 ? textLen : 0;
    r = makeRangeInParagraphTextOffset(hitP, edgeOffset);
  }

  if (!r) return false;
  try { ed.focus({ preventScroll: true } as any); } catch {}
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

function insertPlainTextStrict(ed: HTMLElement, text: string): boolean {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return false;
  let r = selectionRangeIn(ed);
  if (!r) {
    placeCaretAtEnd(ed);
    r = selectionRangeIn(ed);
    if (!r) return false;
  }

  const clean = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");

  // Native-like behavior: single-line paste is inline text, not a new paragraph.
  if (lines.length <= 1) {
    r.deleteContents();
    const tn = document.createTextNode(lines[0] || "");
    r.insertNode(tn);
    const after = document.createRange();
    after.setStartAfter(tn);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    if (editorNeedsStrictParagraphNormalize(ed)) normalizeEditorParagraphsStrict(ed, { preserveSelection: true });
    return true;
  }

  r.deleteContents();
  r = sel.rangeCount ? sel.getRangeAt(0) : r;

  let curP = closestParagraph(r.startContainer);
  if (!curP) {
    normalizeEditorParagraphsStrict(ed, { preserveSelection: true });
    r = selectionRangeIn(ed) || r;
    curP = closestParagraph(r.startContainer) || (ed.querySelector(PSEL) as HTMLElement | null);
  }
  if (!curP) return false;

  const inherit = getPresetOf(curP);
  const align = strictAlignOf(curP);
  removePlaceholderBR(curP);

  // Detach the original tail so multiline paste behaves like normal editors:
  // before + first pasted line / middle lines / last pasted line + original tail.
  const afterRange = document.createRange();
  afterRange.setStart(r.startContainer, r.startOffset);
  afterRange.setEnd(curP, curP.childNodes.length);
  const afterFrag = afterRange.cloneContents();
  afterRange.deleteContents();

  if (lines[0].length) curP.appendChild(document.createTextNode(lines[0]));
  ensureParagraphNotVisuallyEmpty(curP);

  let ref: HTMLElement = curP;
  const lastIndex = lines.length - 1;
  let caretP: HTMLElement | null = null;
  let caretOffset = 0;

  for (let i = 1; i <= lastIndex; i++) {
    const p = makeStrictTextParagraph(lines[i] || "", inherit, align);
    removePlaceholderBR(p);
    if (lines[i].length) p.textContent = lines[i];
    if (i === lastIndex) {
      caretP = p;
      caretOffset = lines[i].length;
      while (afterFrag.firstChild) p.appendChild(afterFrag.firstChild);
      ensureParagraphNotVisuallyEmpty(p);
    } else {
      ensureParagraphNotVisuallyEmpty(p);
    }
    ref.parentNode?.insertBefore(p, ref.nextSibling);
    ref = p;
  }

  // Do not run a global text-offset restore here. Middle-paragraph paste changes the
  // paragraph topology, so global offsets can map back to document start. Put the
  // caret directly in the last inserted paragraph, before the original tail.
  if (caretP) setCaretInParagraphTextOffset(caretP, caretOffset);
  return true;
}

function insertParagraphBreakStrict(ed: HTMLElement): boolean {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return false;
  let r = selectionRangeIn(ed);
  if (!r) return false;

  r.deleteContents();
  r = sel.rangeCount ? sel.getRangeAt(0) : r;

  let curP = closestParagraph(r.startContainer);
  if (!curP) {
    normalizeEditorParagraphsStrict(ed, { preserveSelection: true });
    r = selectionRangeIn(ed) || r;
    curP = closestParagraph(r.startContainer) || (ed.querySelector(PSEL) as HTMLElement | null);
  }
  if (!curP) return false;

  const inherit = getPresetOf(curP);
  const align = strictAlignOf(curP);
  removePlaceholderBR(curP);

  const afterRange = document.createRange();
  afterRange.setStart(r.startContainer, r.startOffset);
  afterRange.setEnd(curP, curP.childNodes.length);
  const afterFrag = afterRange.cloneContents();
  afterRange.deleteContents();
  ensureParagraphNotVisuallyEmpty(curP);

  const nextP = makeStrictParagraphFromFragment(afterFrag, inherit, align);
  curP.parentNode?.insertBefore(nextP, curP.nextSibling);

  removePlaceholderBR(nextP);
  ensureParagraphNotVisuallyEmpty(nextP);
  setCaretInParagraphTextOffset(nextP, 0);
  return true;
}

export default forwardRef<TextBoardHandle, Props>(function TextBoard(props, ref) {
  const edRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nextPresetRef = useRef<Preset | undefined>(undefined);
  const spacerRef = useRef<HTMLDivElement>(null);
  const lastSelRef = useRef<{ start: number; end: number } | null>(null);
  const lastClickPointRef = useRef<{ x: number; y: number; t: number; dirty: boolean } | null>(null);
  const goal = useWritingGoal(edRef as React.RefObject<HTMLElement>, props.writingGoal);
  const [echoOpen, setEchoOpen] = React.useState(false);
  const [echoText, setEchoText] = React.useState("");
  const [echoStartAt, setEchoStartAt] = React.useState(0);
  const [echoBgSources, setEchoBgSources] = React.useState<string[] | undefined>(undefined);
  const enterSnapGuardUntil = React.useRef(0);

  const effectiveId = props.id ?? "";

  const getPlainText = () => {
    const ed = edRef.current!;
    const frag = document.createDocumentFragment();
    Array.from(ed.childNodes).forEach(n => frag.appendChild(n.cloneNode(true)));
    return fragmentToPlainText(frag);
  };

  const [typingMode, setTypingMode] = React.useState<{ bold: boolean; italic: boolean }>({
    bold: false, italic: false,
  });
  const refreshTyping = () => {
    try {
      setTypingMode({
        bold: !!document.queryCommandState?.("bold"),
        italic: !!document.queryCommandState?.("italic"),
      });
    } catch {}
  };

  const toolbarH = Number.isFinite(TOOLBAR_H as any) ? (TOOLBAR_H as number) : 28;
  const S = getStyles({
    color: props.color,
    inset: (props.inset || {}) as Inset,
    toolbarH,
  });

  const [twOn, setTwOn] = React.useState(false);
  const [spellOn, setSpellOn] = React.useState(false);

  // Sync twOn/spellOn states to DOM attributes
  useEffect(() => {
    const wrap = wrapRef.current;
    const ed   = edRef.current;
    if (wrap) {
      if (twOn) wrap.setAttribute("data-typewriter", "1");
      else wrap.removeAttribute("data-typewriter");
    }
    if (ed) ed.setAttribute("spellcheck", spellOn ? "true" : "false");
    updateSpellScope();
  }, [twOn, spellOn]);

  // Observe external mutations and mirror them into local state
  useEffect(() => {
    const wrap = wrapRef.current;
    const ed   = edRef.current;
    if (!wrap || !ed) return;

    const mo = new MutationObserver(() => {
      setTwOn(wrap.getAttribute("data-typewriter") === "1");
      setSpellOn((ed.getAttribute("spellcheck") || "false").toLowerCase() === "true");
    });

    mo.observe(wrap, { attributes: true, attributeFilter: ["data-typewriter"] });
    mo.observe(ed,   { attributes: true, attributeFilter: ["spellcheck"] });
    return () => mo.disconnect();
  }, []);

  // Local toggle bridge within TextBoard
  useEffect(() => {
    const onToggle = (ev: Event) => {
      const d = (ev as CustomEvent<{ id: string; type: "typewriter" | "spell" }>).detail || {};
      if (d.id !== effectiveId) return;
      if (d.type === "typewriter") setTwOn(v => !v);
      if (d.type === "spell")      setSpellOn(v => !v);
    };
    window.addEventListener("sw:text:toggle", onToggle as any, true);
    return () => window.removeEventListener("sw:text:toggle", onToggle as any, true);
  }, [effectiveId]);

  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sc = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!sc || !wrap) return;

    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));

    const apply = (w: number, h: number) => {
      // “1100x720 기준 px”을 패널 크기에 비례해서 환산
      const padTop = clamp((h * 20) / 720, 12, 40);
      const padY   = clamp((h * 18) / 720, 10, 36);
      const padX   = clamp((w * 24) / 1100, 14, 48);

      wrap.style.setProperty("--pad-top", `${padTop}px`);
      wrap.style.setProperty("--pad-y", `${padY}px`);
      wrap.style.setProperty("--pad-x", `${padX}px`);
    };

    // 초기 1회
    const r0 = sc.getBoundingClientRect();
    apply(r0.width, r0.height);

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      apply(r.width, r.height);
    });

    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  const TW_TARGET = 0.58;
  const TW_DEAD   = 24;

  function refreshTypewriterSpacer() {
    const scroller = scrollerRef.current;
    const sp = spacerRef.current;
    if (!scroller || !sp) return;

    if (!twOn) {
      sp.style.height = "4px"; 
      return;
    }

    const extra = Math.ceil(scroller.clientHeight * TW_TARGET) + 240;
    sp.style.height = extra + "px";
  }

  // Serialize/restore selection to absolute text offsets
  function getOffsetsIn(root: HTMLElement, sel: Selection | null) {
    if (!root || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let start = 0, end = 0, pos = 0;
    let gotS = false, gotE = false;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      const len = t.data.length;
      if (!gotS && r.startContainer === t) { start = pos + r.startOffset; gotS = true; }
      if (!gotE && r.endContainer   === t) { end   = pos + r.endOffset;  gotE = true; }
      pos += len;
    }
    if (!gotS || !gotE) return { start: pos, end: pos };
    return { start, end };
  }
  function setSelectionIn(root: HTMLElement, start: number, end: number) {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0, sNode: Text | null = null, eNode: Text | null = null;
    let sOff = 0, eOff = 0;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      const len = t.data.length;
      if (!sNode && start <= pos + len) { sNode = t; sOff = Math.max(0, start - pos); }
      if (!eNode && end   <= pos + len) { eNode = t; eOff = Math.max(0, end   - pos); break; }
      pos += len;
    }
    const r = document.createRange();
    if (!sNode) { r.setStart(root, 0); r.setEnd(root, 0); }
    else if (!eNode) { r.setStart(sNode, sOff); r.setEnd(sNode, sOff); }
    else { r.setStart(sNode, sOff); r.setEnd(eNode, eOff); }
    sel.removeAllRanges();
    sel.addRange(r);
  }


  function restoreRecentClickCaretIfSafe(maxAgeMs = 8000): boolean {
    const ed = edRef.current;
    const a = lastClickPointRef.current;
    if (!ed || !a || a.dirty) return false;
    if (performance.now() - a.t > maxAgeMs) return false;

    const sel = window.getSelection?.();
    // Do not destroy an intentional selection made by drag/shift/double-click.
    if (sel && sel.rangeCount && !sel.isCollapsed) return false;

    return placeCaretFromPointInEditor(ed, a.x, a.y);
  }

  function getCaretRectFromSelection(sel: Selection): DOMRect | null {
    if (!sel || sel.rangeCount === 0) return null;
    let rng: Range | null = null;
    try {
      const r = document.createRange();
      let node: Node | null = sel.focusNode;
      let offset = sel.focusOffset;
      if (!node) throw new Error("no focus");
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const i = Math.min(offset, Math.max(0, el.childNodes.length - 1));
        node = el.childNodes[i] || el;
        offset = 0;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        offset = Math.min(offset, t.data.length);
      } else {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const firstText = walker.nextNode() as Text | null;
        if (firstText) { node = firstText; offset = Math.min(offset, firstText.data.length); }
      }
      r.setStart(node, offset);
      r.collapse(true);
      rng = r;
    } catch {
      const base = sel.getRangeAt(0).cloneRange();
      base.collapse(true);
      rng = base;
    }
    if (!rng) return null;
    let rect = rng.getClientRects()[0] || rng.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const zw = document.createElement("span");
      zw.textContent = "\u200B";
      rng.insertNode(zw);
      rect = zw.getBoundingClientRect();
      zw.parentNode?.removeChild(zw);
    }
    return rect || null;
  }

  function caretYWithMarker(scroller: HTMLElement): number | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;

    const r = sel.getRangeAt(0).cloneRange();
    const mk = document.createElement("span");
    mk.setAttribute("data-tw-marker", "1");
    mk.style.cssText = "display:inline-block;width:0;height:1px;overflow:hidden;";
    r.insertNode(mk);

    const view = scroller.getBoundingClientRect();
    const rect = mk.getBoundingClientRect();
    mk.parentNode?.removeChild(mk);

    const y = rect.top - view.top;
    return Number.isFinite(y) ? y : null;
  }

  function nudgeTypewriter(force = false) {
    const scroller = scrollerRef.current;
    const ed = edRef.current;
    if (!scroller || !ed) return;

    // Block regular nudge during a short guard window after Enter
    if (!force && performance.now() < enterSnapGuardUntil.current) return;

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const view = scroller.getBoundingClientRect();
    let caretY: number | null = null;

    if (force) {
      caretY = caretYWithMarker(scroller);          // Stable measurement
    } else {
      const rect = getCaretRectFromSelection(sel);
      caretY = rect ? (rect.top - view.top) : null;
    }
    if (caretY == null) return;

    const target = scroller.clientHeight * TW_TARGET;
    const delta  = caretY - target;

    if (!force && Math.abs(delta) <= TW_DEAD) return;

    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    let next = scroller.scrollTop + delta;
    if (next < 0) next = 0;
    if (next > maxScroll) next = maxScroll;
    scroller.scrollTop = next;
  }

  // Apply pending preset once after a valid selection exists
  function applyPendingPresetIfAny() {
    const p = nextPresetRef.current;
    if (!p) return false;
    const ed = edRef.current!;
    const r = selectionRangeIn(ed);
    if (!r) return false;
    doApplyPreset(p);
    nextPresetRef.current = undefined;
    return true;
  }

  async function openEcho() {
    const ed = edRef.current;
    if (!ed) return;

    try {
      const sel = window.getSelection?.();
      const paras = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));

      let startAt = 0;

      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        const curP = closestParagraph(r.startContainer);

        if (curP) {
          // 1) 현재 문단 앞에 있는 문단들의 문장 수 누적
          for (const p of paras) {
            if (p === curP) break;
            startAt += tokenCountOfParagraphText(p.textContent || "");
          }

          // 2) 현재 문단 안에서 캐럿 앞까지의 글자 수 → 그 안에서 끝난 문장 수
          let off = 0;
          try {
            const pref = r.cloneRange();
            pref.setStart(curP, 0);
            const frag = pref.cloneContents();
            off = (frag.textContent || "").length;
          } catch {}
          startAt += countEndedBefore(curP.textContent || "", off);
        }
      }

      // 3) 문서 전체 문장 수 계산
      let totalTokens = 0;
      for (const p of paras) {
        totalTokens += tokenCountOfParagraphText(p.textContent || "");
      }

      // 4) 인덱스 보정
      if (totalTokens > 0) {
        if (startAt < 0) startAt = 0;
        else if (startAt >= totalTokens) startAt = totalTokens - 1; // 문서 끝이면 마지막 문장으로
      } else {
        startAt = 0;
      }

      // 5) 상태 업데이트
      setEchoText(ed.innerText || "");
      setEchoStartAt(Math.max(0, startAt));

      const rawBg = (window as any).__SW_ECHO_BG__ ?? null;
      let url: string | undefined;
      try {
        url = await resolveEchoBgUrl(rawBg);
      } catch {
        url = undefined;
      }
      setEchoBgSources(url ? [url] : undefined);
      setEchoOpen(true);
    } catch (err) {
      // 혹시 모를 예외가 있어도 최소한 에코뷰는 열리도록 안전장치
      console.error("EchoView open failed, fallback to start", err);
      try {
        setEchoText(ed.innerText || "");
      } catch {}
      setEchoStartAt(0);
      setEchoBgSources(undefined);
      setEchoOpen(true);
    }
  }

  /* Initial injection */
  useEffect(() => {
    const ed = edRef.current!;
    if (props.initialHTML) ed.innerHTML = props.initialHTML;
    normalizeEditorParagraphsStrict(ed, { preserveSelection: false });
    emitHud({ preset: getPresetOf(ed.querySelector(PSEL) as HTMLElement | null) });
    props.onChange?.(ed.innerHTML);
    goal.bumpGoal();
  }, [props.initialHTML]);

  /* Input events */
  useEffect(() => {
    const ed = edRef.current!;
    const onInput = () => {
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      if (editorNeedsStrictParagraphNormalize(ed)) normalizeEditorParagraphsStrict(ed, { preserveSelection: true });
      else ensureParagraphMarkersNearCaret(ed);
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
    };
    const onCompEnd = () => props.onChange?.(ed.innerHTML);
    const onDrop = () => setTimeout(() => {
      normalizeEditorParagraphsStrict(ed, { preserveSelection: true });
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
    }, 0);

    ed.addEventListener("input", onInput, true);
    ed.addEventListener("compositionend", onCompEnd, true);
    ed.addEventListener("drop", onDrop, true);
    return () => {
      ed.removeEventListener("input", onInput, true);
      ed.removeEventListener("compositionend", onCompEnd, true);
      ed.removeEventListener("drop", onDrop, true);
    };
  }, [props.onChange]);

  // Strict paragraph model: Enter creates exactly one root-level paragraph.
  useEffect(() => {
    const ed = edRef.current!;
    if (!ed) return;

    const onBeforeInput = (e: InputEvent) => {
      const inputType = (e as any).inputType;
      if (inputType !== "insertParagraph") return;
      e.preventDefault();
      e.stopPropagation();
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      if (!insertParagraphBreakStrict(ed)) return;
      props.scheduleSave?.();
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
      if (twRef.current) requestAnimationFrame(() => nudgeTypewriter(true));
    };

    ed.addEventListener("beforeinput", onBeforeInput as any, true);
    return () => ed.removeEventListener("beforeinput", onBeforeInput as any, true);
  }, [props.onChange, props.scheduleSave]);

  // On selection change: update HUD + apply pending preset + refresh spell scope
  useEffect(() => {
    const ed = edRef.current!;
    const upd = () => {
      refreshTyping();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const p = getPresetOf(closestParagraph(sel.getRangeAt(0).startContainer));
      emitHud({ preset: p });
      applyPendingPresetIfAny();
      updateSpellScope();
    };
    document.addEventListener("selectionchange", upd, true);
    ed.addEventListener("keyup", upd, true);
    ed.addEventListener("mouseup", upd, true);
    return () => {
      document.removeEventListener("selectionchange", upd, true);
      ed.removeEventListener("keyup", upd, true);
      ed.removeEventListener("mouseup", upd, true);
    };
  }, []);

  function updateSpellScope() {
    const ed = edRef.current!;
    if (!ed) return;
    const paras = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));
    if (!spellOn) {
      paras.forEach(p => {
        p.removeAttribute("spellcheck");
        p.style.opacity = "";
        p.removeAttribute("data-spell-skip");
      });
      return;
    }
    const r = selectionRangeIn(ed);
    const cur = r ? (closestParagraph(r.startContainer) as HTMLElement | null) : null;
    paras.forEach(p => {
      if (p === cur) {
        p.setAttribute("spellcheck", "true");
        p.style.opacity = "";
        p.removeAttribute("data-spell-skip");
      } else {
        p.setAttribute("spellcheck", "false");
        p.style.opacity = "0.45";
        p.setAttribute("data-spell-skip", "1");
      }
    });
  }

  /* ---- Typewriter: gently nudge scroll to caret on type/click/IME end ---- */
  useEffect(() => {
    const ed = edRef.current!;
    if (!twOn || !ed) return;
    const schedule = () => requestAnimationFrame(() => {
      if (performance.now() < enterSnapGuardUntil.current) return;
      nudgeTypewriter(true);
    });

    refreshTypewriterSpacer();
    const onResize = () => refreshTypewriterSpacer();
    window.addEventListener("resize", onResize);

    schedule();
    ed.addEventListener("input", schedule, true);
    ed.addEventListener("keyup", schedule, true);
    ed.addEventListener("mouseup", schedule, true);
    ed.addEventListener("compositionend", schedule, true);
    return () => {
      ed.removeEventListener("input", schedule, true);
      ed.removeEventListener("keyup", schedule, true);
      ed.removeEventListener("mouseup", schedule, true);
      ed.removeEventListener("compositionend", schedule, true);
      window.removeEventListener("resize", onResize);
    };
  }, [twOn]);

  const focus = () => edRef.current?.focus({ preventScroll: true } as any);

  // MainUI가 Ref로 직접 제어할 수 있게
  const setTypewriter = (on: boolean) => setTwOn(!!on);
  const setSpellcheck = (on: boolean) => setSpellOn(!!on);

  // 최신 상태를 읽게 ref 사용
  const twRef = useRef(false);
  const spRef = useRef(false);
  useEffect(() => { twRef.current = twOn; }, [twOn]);
  useEffect(() => { spRef.current = spellOn; }, [spellOn]);

  const getTypewriter = () => twRef.current;
  const getSpellcheck = () => spRef.current;

  const onFocusZonePointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return; // Right-click should not move focus/caret
    const t = e.target as HTMLElement;
    if (t.closest('[data-sw-editor="1"]')) return;
    if (t.closest('.tb-iconbtn')) return;
    e.preventDefault();
    e.stopPropagation();
    focus();
    if (!t.closest(PSEL)) placeCaretAtEnd(edRef.current!);
  };

  const doApplyPreset = (preset: Preset) => {
    const ed = edRef.current!;
    const targets = paragraphsInSelection(ed);
    targets.forEach((p) => applyPresetToParagraph(p, preset));
    emitHud({ preset });
    props.scheduleSave?.();
    props.onChange?.(ed.innerHTML);
  };

  const applyPreset = (preset: Preset) => {
    const ed = edRef.current!;
    restoreRecentClickCaretIfSafe();
    // Read selection before focus. Focusing from toolbar/topbar can collapse
    // contentEditable selection to the document start in WebView when caret is
    // in a middle paragraph.
    const r = selectionRangeIn(ed);
    if (!r) {
      focus();
      nextPresetRef.current = preset;
      return;
    }
    doApplyPreset(preset);
  };

  const align = (kind: "left" | "center" | "right" | "justify") => {
    const ed = edRef.current!;
    restoreRecentClickCaretIfSafe();
    const targets = paragraphsInSelection(ed);
    targets.forEach((p) => (p.style.textAlign = kind === "justify" ? "justify" : kind));
    props.scheduleSave?.();
    props.onChange?.(ed.innerHTML);
  };

  const toggleBold   = () => { focus(); try { document.execCommand("bold"); } catch {}   props.scheduleSave?.(); props.onChange?.(edRef.current!.innerHTML); refreshTyping(); };
  const toggleItalic = () => { focus(); try { document.execCommand("italic"); } catch {} props.scheduleSave?.(); props.onChange?.(edRef.current!.innerHTML); refreshTyping(); };

  const getHTML = () => edRef.current!.innerHTML;
  const setHTML = (html: string) => {
    const ed = edRef.current!;
    ed.innerHTML = html || "";
    normalizeEditorParagraphsStrict(ed, { preserveSelection: false });
    props.onChange?.(ed.innerHTML);
    goal.bumpGoal();
  };
  const getText = () => edRef.current!.innerText || "";

  useImperativeHandle(
    ref,
    () => ({
      focus, applyPreset, align, toggleBold, toggleItalic, getHTML, setHTML, getText,
      setTypewriter, setSpellcheck, getTypewriter, getSpellcheck, getPlainText, 
    }),
    [props.scheduleSave]
  );

  useEffect(() => {
    const ed = edRef.current!;
    const onKey = (ev: KeyboardEvent) => {
      if (!isEventInsideEditor(ed)) return;
      // Ignore during IME composition (except Enter)
      // @ts-ignore
      const composing = (ev as any).isComposing;
      const key = ev.key; 
      if (composing && key !== "Enter") return;

      if (nextPresetRef.current) applyPendingPresetIfAny();

      const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
      const alt = ev.altKey;
      const shift = ev.shiftKey;
      const code = ev.code;
      const lower = (key ?? "").toLowerCase();

      // Tab: keep the real \t character for export/copy handoff.
      // CSS decides the visual width via tab-size.
      if (key === "Tab" && !ctrlOrMeta && !alt) {
        ev.preventDefault();
        ev.stopPropagation();

        if (shift) {
          const r = selectionRangeIn(ed);
          const p = r ? closestParagraph(r.startContainer) : null;
          if (p) {
            const before = getOffsetsIn(ed, window.getSelection?.() || null);
            const pStart = textOffsetBeforeNode(ed, p);
            const removed = removeLeadingTabFromParagraph(p);
            if (removed) {
              ensureParagraphMarkersNearCaret(ed);
              if (before) {
                const adjust = (v: number) => v > pStart ? Math.max(pStart, v - TAB_STR.length) : v;
                setSelectionIn(ed, adjust(before.start), adjust(before.end));
              }
              props.scheduleSave?.();
              props.onChange?.(ed.innerHTML);
              goal.bumpGoal();
              if (twRef.current) requestAnimationFrame(() => nudgeTypewriter(true));
            }
          }
        } else {
          insertRawTextAtSelection(
            ed,
            TAB_STR,
            props.scheduleSave,
            (h) => props.onChange?.(h),
            () => { if (twRef.current) requestAnimationFrame(() => nudgeTypewriter(true)); }
          );
          goal.bumpGoal();
        }
        return;
      }

      const isDigit = (want: string) =>
        code === `Digit${want}` || key === want || key === "!@#$"[parseInt(want, 10) - 1];

      if ((ctrlOrMeta || alt) && !shift) {
        let p: Preset | undefined;
        if (isDigit("1")) p = 1;
        else if (isDigit("2")) p = 2;
        else if (isDigit("3")) p = 3;
        else if (isDigit("4")) p = 4;

        if (p) {
          ev.preventDefault(); ev.stopPropagation();
          restoreRecentClickCaretIfSafe();
          const r = selectionRangeIn(ed);
          if (!r) { nextPresetRef.current = p; return; }
          doApplyPreset(p);
          return;
        }
      }

      // Bold/Italic
      if (ctrlOrMeta && !alt && !shift) {
        if (code === "KeyB" || lower === "b") { ev.preventDefault(); ev.stopPropagation(); toggleBold(); return; }
        if (code === "KeyI" || lower === "i") { ev.preventDefault(); ev.stopPropagation(); toggleItalic(); return; }
      }

      // Ellipsis: Alt + M
      if (!ctrlOrMeta && alt && !shift && (code === "KeyM" || lower === "m")) {
        ev.preventDefault(); ev.stopPropagation();
        insertEllipsisAtSelection(
          ed,
          props.scheduleSave,
          (h) => props.onChange?.(h),
          () => { if (twRef.current) requestAnimationFrame(() => nudgeTypewriter(true)); }
        );
        return;
      }

      const alignKey =
        code === "KeyL" || lower === "l" ? "left" :
        code === "KeyC" || lower === "c" ? "center" :
        code === "KeyR" || lower === "r" ? "right" :
        code === "KeyJ" || lower === "j" ? "justify" : null;

      if (alignKey && ((ctrlOrMeta && shift && !alt) || (alt && !ctrlOrMeta && !shift))) {
        ev.preventDefault(); ev.stopPropagation(); align(alignKey as any); return;
      }

      // Enter
      if (key === "Enter" && !shift && !alt && !ctrlOrMeta) {
        if (twRef.current) {
          // After Enter, temporarily block regular nudges for 240ms
          enterSnapGuardUntil.current = performance.now() + 240;

          // Apply preset to the new paragraph on the next frame after DOM insertion
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const sc = scrollerRef.current;
            if (!sc) return;

            const y = caretYWithMarker(sc);
            if (y == null) return;

            const target = sc.clientHeight * TW_TARGET;
            const max = sc.scrollHeight - sc.clientHeight;
            let next = sc.scrollTop + (y - target);
            if (next < 0) next = 0;
            if (next > max) next = max;
            sc.scrollTop = next;

            // Give a little extra time and then release the guard
            enterSnapGuardUntil.current = performance.now() + 40;
          }));
        }
      }
    };

    ed.addEventListener("keydown", onKey as any, true);
    return () => ed.removeEventListener("keydown", onKey as any, true);
  }, [props.scheduleSave]);

  /* ---- Paste: strict plaintext insertion; no execCommand("insertHTML") ---- */
  useEffect(() => {
    const ed = edRef.current!;
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      restoreRecentClickCaretIfSafe();
      insertPlainTextStrict(ed, text);
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      props.scheduleSave?.();
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
      if (twRef.current) requestAnimationFrame(() => nudgeTypewriter(true));
    };

    ed.addEventListener("paste", onPaste as any, true);
    return () => ed.removeEventListener("paste", onPaste as any, true);
  }, [props.scheduleSave, props.onChange]);

  /* ---- Copy: normalize selection and export as text/plain ---- */
  useEffect(() => {
    const ed = edRef.current!;
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      if (!ed.contains(sel.anchorNode)) return;

      const r = sel.getRangeAt(0);
      const frag = r.cloneContents();
      const text = fragmentToPlainText(frag);

      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };

    ed.addEventListener("copy", onCopy as any);
    return () => ed.removeEventListener("copy", onCopy as any);
  }, []);

  /* ---- Undo/Redo + Curly replacement ---- */
  useEffect(() => {
    const ed = edRef.current!;
    const c = normalizeCurly(props.curly);
    const curlySetting =
      c && (c as any).enabled
        ? { enabled: true, map: { left: (c as any).left, right: (c as any).right } }
        : { enabled: false, map: { left: "{", right: "}" } };

    const ctl = attachUndoCurly(ed, {
      boardId: effectiveId,
      limit: 20,
      curly: curlySetting,
      hooks: { scheduleSave: props.scheduleSave },
    });
    return () => ctl.destroy();
  }, [effectiveId, props.curly, props.scheduleSave]);

  // WebView/contentEditable can keep the previous caret when moving from a lower paragraph
  // back to an upper paragraph. Anchor every non-drag LMB release by its real screen
  // point so the next paste/preset command does not reuse a stale selection.
  // Drag selections are preserved; double-click word selection is intentionally ignored.
  useEffect(() => {
    const ed = edRef.current!;
    if (!ed) return;

    let down: { x: number; y: number; t: number } | null = null;

    const markDirtyByKey = (e: KeyboardEvent) => {
      if (!lastClickPointRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key || "";
      if (
        k.length === 1 ||
        k === "Backspace" || k === "Delete" || k === "Enter" || k === "Tab" ||
        k.startsWith("Arrow") || k === "Home" || k === "End" || k === "PageUp" || k === "PageDown"
      ) {
        lastClickPointRef.current.dirty = true;
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!ed.contains(e.target as Node)) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !down) return;
      if (!ed.contains(e.target as Node)) { down = null; return; }
      const dx = Math.abs(e.clientX - down.x);
      const dy = Math.abs(e.clientY - down.y);
      const isDrag = dx > 4 || dy > 4;
      const pt = { x: e.clientX, y: e.clientY };
      down = null;
      if (isDrag) return;

      // v5: TextBoard deliberately does not support browser double-click word selection.
      // Any non-drag LMB release is treated as a plain caret placement.
      // This keeps accidental double-clicks from leaving a word selection or stale range
      // that can corrupt the next paste/preset command.
      const anchoredNow = placeCaretFromPointInEditor(ed, pt.x, pt.y);
      if (anchoredNow) {
        lastClickPointRef.current = { x: pt.x, y: pt.y, t: performance.now(), dirty: false };
      }

      // Safety pass: if WebView applies a late native selection after mouseup, repair it
      // before the next command. Do not touch intentional selections.
      requestAnimationFrame(() => {
        const sel = window.getSelection?.();
        if (!lastClickPointRef.current || lastClickPointRef.current.dirty) return;
        if (sel && sel.rangeCount && !sel.isCollapsed) return;

        const hit = document.elementFromPoint(pt.x, pt.y) as HTMLElement | null;
        const intendedP = hit?.closest?.(PSEL) as HTMLElement | null;
        const currentP = sel && sel.rangeCount ? closestParagraph(sel.getRangeAt(0).startContainer) : null;

        if (intendedP && currentP !== intendedP) {
          placeCaretFromPointInEditor(ed, pt.x, pt.y);
        }
      });
    };

    ed.addEventListener("mousedown", onMouseDown, true);
    ed.addEventListener("mouseup", onMouseUp, true);
    ed.addEventListener("keydown", markDirtyByKey, true);
    return () => {
      ed.removeEventListener("mousedown", onMouseDown, true);
      ed.removeEventListener("mouseup", onMouseUp, true);
      ed.removeEventListener("keydown", markDirtyByKey, true);
    };
  }, []);

  useEffect(() => {
    const ed = edRef.current!;
    if (!ed) return;

    const onCtx = (e: MouseEvent) => {
      if (!ed.contains(e.target as Node)) return;
      const off = getOffsetsIn(ed, window.getSelection?.() || null);
      if (off) lastSelRef.current = off;

      requestAnimationFrame(() => {
        const saved = lastSelRef.current;
        if (saved) {
          setSelectionIn(ed, saved.start, saved.end);
          if (twRef.current) nudgeTypewriter();
        }
      });
    };

    document.addEventListener("contextmenu", onCtx, true);
    return () => document.removeEventListener("contextmenu", onCtx, true);
  }, []);

  // Recompute spacer on typewriter ON/OFF; visibility fix when OFF
  useEffect(() => {
    refreshTypewriterSpacer();
    if (!twOn) {
      requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const sel = window.getSelection?.();
        if (!sel || !sel.rangeCount) return;

        const rect = getCaretRectFromSelection(sel);
        if (!rect) return;

        const view = scroller.getBoundingClientRect();
        const margin = 24;
        let dy = 0;
        if (rect.top < view.top + margin) dy = rect.top - (view.top + margin);
        else if (rect.bottom > view.bottom - margin) dy = rect.bottom - (view.bottom - margin);

        if (dy !== 0) {
          const max = scroller.scrollHeight - scroller.clientHeight;
          let next = scroller.scrollTop + dy;
          if (next < 0) next = 0;
          if (next > max) next = max;
          scroller.scrollTop = next;
        }
      });
    }
  }, [twOn]);

  useEffect(() => {
    if (!twOn) return;
    const ed = edRef.current; if (!ed) return;

    const onCompEndLock = () => {
      requestAnimationFrame(() => nudgeTypewriter(true));
    };

    ed.addEventListener("compositionend", onCompEndLock, true);
    return () => ed.removeEventListener("compositionend", onCompEndLock, true);
  }, [twOn]);

  useEffect(() => {
    props.onHUDChange?.({
      writingGoal: {
        enabled: goal.goalEnabled,
        mode: goal.goalMode,
        target: goal.goalTarget,
        current: goal.currentCount,
      }
    });
  }, [goal.goalEnabled, goal.goalMode, goal.goalTarget, goal.currentCount]);

  return (
    <div
      ref={wrapRef}
      data-board-id={effectiveId}
      data-typewriter={twOn ? "1" : undefined} 
      style={{ ...S.wrap, WebkitAppRegion: "no-drag" as any }}
    >
      {createPortal(<WindowResizeEdges />, document.body)}
      <EchoReader
        open={echoOpen}
        onClose={() => setEchoOpen(false)}
        text={echoText}
        startAt={echoStartAt}
        preset={2}
        typefaces={props.typefaces}
        bgSources={echoBgSources} 
      />
      <div style={S.toolbarBox}>
        <TextToolbar
          typingMode={typingMode}
          onBold={toggleBold}
          onItalic={toggleItalic}
          onAlignLeft={() => align("left")}
          onAlignCenter={() => align("center")}
          onAlignRight={() => align("right")}
          onAlignJustify={() => align("justify")}
          onOpenEcho={openEcho}
          onToolbarPointerDown={() => {
            // Intentionally no focus here. Toolbar buttons already prevent mouse down
            // from stealing selection; forcing focus is what makes middle-paragraph
            // preset changes collapse to the document start in WebView.
          }}
          writingGoal={
            goal.goalEnabled
              ? {
                  enabled: true,
                  mode: goal.goalMode,
                  target: goal.goalTarget,
                  current: goal.currentCount,
                  format: goal.goalFormat,
                }
              : undefined
          }
        />
      </div>
      <div style={S.divider} onPointerDown={onFocusZonePointerDown} />

      <div
        style={{ ...S.editorWrap, overflowAnchor: twOn ? "none" as any : "auto" as any }}
        ref={scrollerRef}
        onPointerDown={onFocusZonePointerDown}
      >
        <div style={{ ...S.editorCol, overflowAnchor: twOn ? "none" as any : "auto" as any }}>
          <div style={{ height: twOn ? 0 : 12, pointerEvents: "none" }} />
          <div
            ref={edRef}
            data-role="editor-root" 
            className={["editor-area", props.className].filter(Boolean).join(" ")}
            data-sw-editor="1"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Write here…"
            spellCheck={spellOn}
            tabIndex={0}
            style={{
              outline: "none",
              whiteSpace: "pre-wrap",
              tabSize: 2,
              wordBreak: "break-word",
              minHeight: 0,
              padding: "10px 14px",
              color: "var(--text-1)",
              textAlign: "justify",
              overflowAnchor: twOn ? ("none" as any) : undefined,
            }}
            onMouseDown={(e) => {
              if (e.button === 2) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              // Left click inside contentEditable must be handled by the browser;
              // forcing focus here can reset the native caret calculation.
            }}
          />
          <div ref={spacerRef} style={{ height: 0, pointerEvents: "none" }} />
        </div>
      </div>
    </div>
  );
});
