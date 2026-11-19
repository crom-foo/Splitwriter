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
import EchoReader, { countEchoChunks } from "../ui/EchoView";

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
  scenario?: boolean;

  // Other props currently in use (compatibility)
  className?: string;
  accentColor?: string;
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
const HISTORY_BOUNDARY_EVENT = "sw:history:boundary";

function markHistoryBoundary(ed: HTMLElement) {
  ed.dispatchEvent(new Event(HISTORY_BOUNDARY_EVENT));
}

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
  return ed.contains(r.startContainer) && ed.contains(r.endContainer) ? r : null;
}
function isEventInsideEditor(ed: HTMLElement): boolean {
  const active = document.activeElement;
  return !!(active && ed.contains(active));
}
function paragraphsInSelection(ed: HTMLElement): HTMLElement[] {
  const r = selectionRangeIn(ed);
  const paras = Array.from(ed.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.matches(PSEL)
  );
  if (!paras.length) return [];
  if (!r) return [];
  if (r.collapsed) {
    const base = (r.startContainer.nodeType === 1
      ? (r.startContainer as HTMLElement)
      : (r.startContainer.parentElement as HTMLElement));
    const p = base?.closest(PSEL) as HTMLElement | null;
    return p && p.parentElement === ed ? [p] : [];
  }

  // A non-collapsed selection applies to every paragraph between its two
  // endpoints. This also handles mixed presets by replacing each paragraph's
  // preset class with the one chosen by the user.
  const startP = closestParagraph(r.startContainer);
  const endP = closestParagraph(r.endContainer);
  const startIndex = startP?.parentElement === ed ? paras.indexOf(startP) : -1;
  const endIndex = endP?.parentElement === ed ? paras.indexOf(endP) : -1;
  if (startIndex >= 0 && endIndex >= 0) {
    return paras.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1);
  }

  // Fallback for selections whose boundary is on the editor element itself.
  const out: HTMLElement[] = [];
  for (const p of paras) {
    try {
      if (r.intersectsNode(p)) out.push(p);
    } catch {
      // Ignore malformed ranges; no paragraph should be changed without a
      // reliable intersection result.
    }
  }
  return out;
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

type InlineFormat = "bold" | "italic";

function selectedTextNodes(ed: HTMLElement, range: Range): Text[] {
  const nodes: Text[] = [];
  const selectedStart = textOffsetAt(ed, range.startContainer, range.startOffset);
  const selectedEnd = textOffsetAt(ed, range.endContainer, range.endOffset);
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  let position = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const end = position + node.data.length;
    if (node.data.length && selectedStart < end && selectedEnd > position) nodes.push(node);
    position = end;
  }
  return nodes;
}

function isInlineFormatActive(node: Text | HTMLElement, format: InlineFormat): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  if (!el) return false;
  const style = getComputedStyle(el);
  if (format === "italic") return style.fontStyle === "italic" || style.fontStyle === "oblique";
  const weight = Number.parseInt(style.fontWeight, 10);
  return style.fontWeight === "bold" || (Number.isFinite(weight) && weight >= 600);
}

type InlineStyleState = { bold: boolean; italic: boolean };

function stateFromInlineElement(el: HTMLElement, inherited: InlineStyleState): InlineStyleState {
  const state = { ...inherited };
  const tag = el.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") state.bold = true;
  if (tag === "i" || tag === "em") state.italic = true;
  const weight = el.style.fontWeight.toLowerCase();
  if (weight) {
    const numericWeight = Number.parseInt(weight, 10);
    state.bold = weight === "bold" || (Number.isFinite(numericWeight) && numericWeight >= 600);
  }
  const fontStyle = el.style.fontStyle.toLowerCase();
  if (fontStyle) state.italic = fontStyle === "italic" || fontStyle === "oblique";
  return state;
}

function rewriteParagraphInlineFormat(
  paragraph: HTMLElement,
  selectedStart: number,
  selectedEnd: number,
  format: InlineFormat,
  enabled: boolean,
  forcedState?: InlineStyleState,
): void {
  const output = document.createDocumentFragment();
  const inherited = {
    bold: isInlineFormatActive(paragraph, "bold"),
    italic: isInlineFormatActive(paragraph, "italic"),
  };
  let textPosition = 0;

  const appendText = (target: Node, value: string, state: InlineStyleState, isSelected: boolean) => {
    if (!value) return;
    const next = !isSelected
      ? state
      : forcedState ?? { ...state, [format]: enabled } as InlineStyleState;
    if (!next.bold && !next.italic) target.appendChild(document.createTextNode(value));
    else {
      const span = document.createElement("span");
      if (next.bold) span.style.fontWeight = "bold";
      if (next.italic) span.style.fontStyle = "italic";
      span.textContent = value;
      target.appendChild(span);
    }
  };

  const walk = (node: Node, target: Node, state: InlineStyleState) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || "";
      const from = textPosition;
      const to = from + value.length;
      const cuts = [0, value.length];
      if (selectedStart > from && selectedStart < to) cuts.push(selectedStart - from);
      if (selectedEnd > from && selectedEnd < to) cuts.push(selectedEnd - from);
      cuts.sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i];
        const b = cuts[i + 1];
        const segmentStart = from + a;
        const segmentEnd = from + b;
        const selected = segmentStart < selectedEnd && segmentEnd > selectedStart;
        appendText(target, value.slice(a, b), state, selected);
      }
      textPosition = to;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      target.appendChild(el.cloneNode(false));
      return;
    }
    const next = stateFromInlineElement(el, state);
    const tag = el.tagName.toLowerCase();
    const shell = el.cloneNode(false) as HTMLElement;
    if (tag === "b" || tag === "strong" || tag === "i" || tag === "em") {
      const semantic = document.createElement("span");
      for (const attr of Array.from(shell.attributes)) semantic.setAttribute(attr.name, attr.value);
      semantic.style.removeProperty("font-weight");
      semantic.style.removeProperty("font-style");
      if (!semantic.style.cssText) semantic.removeAttribute("style");
      const redundant = semantic.attributes.length === 0;
      const childTarget = redundant ? target : semantic;
      if (!redundant) target.appendChild(semantic);
      Array.from(el.childNodes).forEach((child) => walk(child, childTarget, next));
      return;
    }
    shell.style.removeProperty("font-weight");
    shell.style.removeProperty("font-style");
    if (!shell.style.cssText) shell.removeAttribute("style");
    const redundantSpan = shell instanceof HTMLElement &&
      shell.tagName === "SPAN" && shell.attributes.length === 0;
    const childTarget = redundantSpan ? target : shell;
    if (!redundantSpan) target.appendChild(shell);
    Array.from(el.childNodes).forEach((child) => walk(child, childTarget, next));
  };

  Array.from(paragraph.childNodes).forEach((node) => walk(node, output, inherited));
  paragraph.replaceChildren(output);
}

function applyInlineStateToTextRange(ed: HTMLElement, start: number, end: number, state: InlineStyleState) {
  if (end <= start) return;
  let position = 0;
  const paragraphs = Array.from(ed.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.matches(PSEL),
  );
  for (const paragraph of paragraphs) {
    const length = paragraph.textContent?.length || 0;
    const localStart = Math.max(0, start - position);
    const localEnd = Math.min(length, end - position);
    if (localStart < localEnd) {
      rewriteParagraphInlineFormat(paragraph, localStart, localEnd, "bold", state.bold, state);
    }
    position += length;
  }
}

function textRangeHasInlineState(
  ed: HTMLElement,
  start: number,
  end: number,
  expected: InlineStyleState,
): boolean {
  if (end <= start) return true;
  const from = textPointAt(ed, start, "start");
  const to = textPointAt(ed, end, "end");
  if (!from || !to) return false;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const nodes = selectedTextNodes(ed, range);
  return nodes.length > 0 && nodes.every((node) =>
    isInlineFormatActive(node, "bold") === expected.bold &&
    isInlineFormatActive(node, "italic") === expected.italic
  );
}

function paragraphPartOfRange(range: Range, p: HTMLElement): Range | null {
  const whole = document.createRange();
  whole.selectNodeContents(p);
  const part = document.createRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0) {
    part.setStart(whole.startContainer, whole.startOffset);
  } else {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0) {
    part.setEnd(whole.endContainer, whole.endOffset);
  } else {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.collapsed ? null : part;
}

function textOffsetAt(root: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (text === node) return position + Math.max(0, Math.min(offset, text.data.length));
    const textEnd = document.createRange();
    textEnd.setStart(text, text.data.length);
    textEnd.collapse(true);
    const boundary = document.createRange();
    boundary.setStart(node, offset);
    boundary.collapse(true);
    if (textEnd.compareBoundaryPoints(Range.START_TO_START, boundary) <= 0) {
      position += text.data.length;
    } else {
      break;
    }
  }
  return position;
}

function textPointAt(
  root: HTMLElement,
  target: number,
  bias: "start" | "end" = "start",
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    const end = position + node.data.length;
    if (target < end || (target === end && bias === "end")) {
      return { node, offset: Math.max(0, target - position) };
    }
    position = end;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function applyInlineFormatToSelection(ed: HTMLElement, format: InlineFormat, enabled: boolean): boolean {
  const selection = window.getSelection?.();
  const original = selectionRangeIn(ed);
  if (!selection || !original || original.collapsed || !original.toString().length) return false;
  const startTextOffset = textOffsetAt(ed, original.startContainer, original.startOffset);
  const endTextOffset = textOffsetAt(ed, original.endContainer, original.endOffset);
  const backward = selection.anchorNode !== original.startContainer ||
    selection.anchorOffset !== original.startOffset;
  const paragraphs = paragraphsInSelection(ed);
  const parts = paragraphs
    .map((paragraph) => ({ paragraph, part: paragraphPartOfRange(original, paragraph) }))
    .filter((entry): entry is { paragraph: HTMLElement; part: Range } => !!entry.part)
    .reverse();

  for (const { paragraph, part } of parts) {
    const start = textOffsetAt(paragraph, part.startContainer, part.startOffset);
    const end = textOffsetAt(paragraph, part.endContainer, part.endOffset);
    rewriteParagraphInlineFormat(paragraph, start, end, format, enabled);
  }

  const startPoint = textPointAt(ed, startTextOffset, "start");
  const endPoint = textPointAt(ed, endTextOffset, "end");
  if (startPoint && endPoint) {
    selection.removeAllRanges();
    if (backward) {
      selection.collapse(endPoint.node, endPoint.offset);
      selection.extend(startPoint.node, startPoint.offset);
    } else {
      const restored = document.createRange();
      restored.setStart(startPoint.node, startPoint.offset);
      restored.setEnd(endPoint.node, endPoint.offset);
      selection.addRange(restored);
    }
  }
  return true;
}

function normalizeNativeEmphasisAtCaret(ed: HTMLElement) {
  const selection = window.getSelection?.();
  const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const p = current ? closestParagraph(current.startContainer) : null;
  if (!p) return;
  const legacy = Array.from(p.querySelectorAll<HTMLElement>("b,strong,i,em"));
  if (!legacy.length) return;

  // Replacing a browser-created <b>/<i> ancestor can invalidate the WebView's
  // live caret and make the first typed character jump to the paragraph end.
  // A temporary marker stays at the exact insertion point while wrappers are
  // converted to spans.
  const caretMarker = current?.collapsed ? document.createComment("sw-format-caret") : null;
  if (caretMarker && current && p.contains(current.startContainer)) {
    try { current.insertNode(caretMarker); } catch {}
  }

  for (const el of legacy.reverse()) {
    const span = document.createElement("span");
    for (const attr of Array.from(el.attributes)) span.setAttribute(attr.name, attr.value);
    if (el.tagName === "B" || el.tagName === "STRONG") span.style.fontWeight = "bold";
    else span.style.fontStyle = "italic";
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
  }

  if (caretMarker?.parentNode && selection) {
    try {
      const restored = document.createRange();
      restored.setStartBefore(caretMarker);
      restored.collapse(true);
      selection.removeAllRanges();
      selection.addRange(restored);
    } catch {}
    caretMarker.remove();
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

function fragmentToPlainText(frag: DocumentFragment, paragraphBreak = "\n\n"): string {
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
    if (isPara) out += paragraphBreak;
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
  markHistoryBoundary(root);

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

  root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromCustom" }));
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
  markHistoryBoundary(root);

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
  root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromCustom" }));
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

function removeLeadingTabFromParagraph(p: HTMLElement, beforeRemove?: () => void): boolean {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.data.length) continue;
    if (t.data.startsWith(TAB_STR)) {
      beforeRemove?.();
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
      if (!strictHasMeaningfulContent(part) && !el.hasAttribute("data-scenario-part")) return;
      const shell = el.cloneNode(false) as HTMLElement;
      stripUnsafeCloneAttrs(shell);
      if (shell.getAttribute("data-scenario-part") === "separator") {
        shell.setAttribute("contenteditable", "false");
      }
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

  Array.from(nodes).forEach(walk);

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

  const addLines = (lines: DocumentFragment[], preset: Preset, align: "left" | "center" | "right" | "justify", scenarioBlock?: string | null, scenarioPlaceholder?: string | null) => {
    for (const line of lines) {
      const paragraph = makeStrictParagraphFromFragment(line, preset, align);
      if (scenarioBlock) paragraph.setAttribute("data-scenario-block", scenarioBlock);
      if (scenarioPlaceholder) paragraph.setAttribute("data-scenario-placeholder", scenarioPlaceholder);
      paras.push(paragraph);
    }
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
    const scenarioBlock = el.matches(PSEL) ? el.getAttribute("data-scenario-block") : null;
    const scenarioPlaceholder = el.matches(PSEL) ? el.getAttribute("data-scenario-placeholder") : null;
    const lines = splitNodesToLineFragments(Array.from(el.childNodes) as ChildNode[]);
    addLines(lines.length ? lines : [document.createDocumentFragment()], preset, align, scenarioBlock, scenarioPlaceholder);
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

  let clean = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n");
  const paragraphs = Array.from(ed.children);
  const isEmptyBoard = paragraphs.length > 0 && paragraphs.every((paragraph) =>
    paragraph instanceof HTMLElement &&
    paragraph.matches(PSEL) &&
    !strictHasMeaningfulContent(paragraph)
  );
  const isAtBoardStart = r.collapsed && textOffsetAt(ed, r.startContainer, r.startOffset) === 0;

  // Some external sources include a leading newline in their plain-text
  // clipboard payload (sometimes preceded by a BOM or zero-width marker).
  // Ignore it only at the start of an otherwise empty board.
  if (isEmptyBoard && isAtBoardStart) {
    clean = clean.replace(/^(?:[ \t\u00a0\ufeff\u200b\u2060]*\n)+/, "");
  }
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

/** Join adjacent root paragraphs without rebuilding the editor or restoring a
 * document-wide text offset. The temporary comment gives the caret a stable
 * DOM position at the join, including when either paragraph is empty. */
function joinParagraphAtBoundary(p: HTMLElement, direction: "backward" | "forward"): boolean {
  const ed = p.parentElement;
  if (!ed) return false;
  const other = (direction === "backward" ? p.previousElementSibling : p.nextElementSibling) as HTMLElement | null;
  if (!other || !other.matches(PSEL)) return false;

  const left = direction === "backward" ? other : p;
  const right = direction === "backward" ? p : other;
  removePlaceholderBR(left);
  removePlaceholderBR(right);

  const marker = document.createComment("sw-caret");
  left.appendChild(marker);
  while (right.firstChild) left.appendChild(right.firstChild);
  right.remove();
  if (!strictHasMeaningfulContent(left)) left.appendChild(document.createElement("br"));

  const sel = window.getSelection?.();
  if (sel) {
    const range = document.createRange();
    range.setStartBefore(marker);
    range.collapse(true);
    marker.parentNode?.removeChild(marker);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    marker.remove();
  }
  return true;
}

function caretAtParagraphBoundary(p: HTMLElement, range: Range, edge: "start" | "end"): boolean {
  if (!range.collapsed) return false;
  const probe = document.createRange();
  probe.selectNodeContents(p);
  if (edge === "start") {
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length === 0;
  }
  probe.setStart(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}

export default forwardRef<TextBoardHandle, Props>(function TextBoard(props, ref) {
  const edRef = useRef<HTMLDivElement>(null);
  const editorColRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nextPresetRef = useRef<Preset | undefined>(undefined);
  const spacerRef = useRef<HTMLDivElement>(null);
  const lastSelRef = useRef<{ start: number; end: number } | null>(null);
  const lastClickPointRef = useRef<{ x: number; y: number; t: number; dirty: boolean } | null>(null);
  const goal = useWritingGoal(edRef as React.RefObject<HTMLElement>, props.writingGoal);
  const onChangeRef = useRef(props.onChange);
  const bumpGoalRef = useRef(goal.bumpGoal);
  const curlySettingRef = useRef({ enabled: false, map: { left: "{", right: "}" } });
  onChangeRef.current = props.onChange;
  bumpGoalRef.current = goal.bumpGoal;
  const curlyConfig = normalizeCurly(props.curly);
  curlySettingRef.current = curlyConfig && (curlyConfig as any).enabled
    ? { enabled: true, map: { left: (curlyConfig as any).left, right: (curlyConfig as any).right } }
    : { enabled: false, map: { left: "{", right: "}" } };
  const [echoOpen, setEchoOpen] = React.useState(false);
  const [echoText, setEchoText] = React.useState("");
  const [echoStartAt, setEchoStartAt] = React.useState(0);
  const [echoStartAtByMode, setEchoStartAtByMode] = React.useState<{ SMART: number; ENTER: number }>({ SMART: 0, ENTER: 0 });
  const [echoBgSources, setEchoBgSources] = React.useState<string[] | undefined>(undefined);
  const [echoMarkerParagraphIndex, setEchoMarkerParagraphIndex] = React.useState<number | null>(null);
  const [echoMarkerPosition, setEchoMarkerPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [scenarioDialogueAnchors, setScenarioDialogueAnchors] = React.useState<Array<{ index: number; left: number; top: number }>>([]);
  const [scenarioFormatWidth, setScenarioFormatWidth] = React.useState(90);
  const echoStartTextOffsetRef = useRef<number | null>(null);
  const rightClickTextOffsetRef = useRef<number | null>(null);
  const rightClickParagraphIndexRef = useRef<number | null>(null);
  const echoMarkerParagraphIndexRef = useRef<number | null>(null);
  const enterSnapGuardUntil = React.useRef(0);

  const effectiveId = props.id ?? "";

  useEffect(() => {
    const ed = edRef.current;
    const col = editorColRef.current;
    const scroller = scrollerRef.current;
    if (!props.scenario || !ed || !col || !scroller) {
      setScenarioDialogueAnchors([]);
      return;
    }

    let frame = 0;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const colRect = col.getBoundingClientRect();
        const next = Array.from(ed.querySelectorAll<HTMLElement>(`${PSEL}[data-scenario-block="dialogue"]`))
          .map((paragraph, index) => {
            const rect = paragraph.getBoundingClientRect();
            return {
              index,
              left: rect.right - colRect.left + 6,
              top: rect.top - colRect.top + rect.height / 2 - 11,
            };
          });
        setScenarioDialogueAnchors((current) => {
          if (current.length === next.length && current.every((item, index) =>
            item.index === next[index]?.index && Math.abs(item.left - next[index].left) < 1 && Math.abs(item.top - next[index].top) < 1
          )) return current;
          return next;
        });
      });
    };

    const observer = new MutationObserver(update);
    observer.observe(ed, { subtree: true, childList: true, characterData: true });
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    resizeObserver?.observe(ed);
    resizeObserver?.observe(col);
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [props.scenario]);

  const addScenarioDialogue = (dialogueIndex: number) => {
    const ed = edRef.current;
    if (!props.scenario || !ed) return;
    const dialogue = ed.querySelectorAll<HTMLElement>(`${PSEL}[data-scenario-block="dialogue"]`)[dialogueIndex];
    if (!dialogue) return;

    const createBlock = (block: string, preset: Preset, align: "left" | "center" | "right" | "justify") => {
      const paragraph = makeStrictParagraphFromFragment(document.createDocumentFragment(), preset, align);
      paragraph.setAttribute("data-scenario-block", block);
      paragraph.setAttribute("data-scenario-placeholder", block === "parenthetical" ? "Parenthetical (optional)" : block[0].toUpperCase() + block.slice(1));
      return paragraph;
    };
    const character = createBlock("character", 3, "center");
    const parenthetical = createBlock("parenthetical", 4, "left");
    const nextDialogue = createBlock("dialogue", 2, "left");
    markHistoryBoundary(ed);
    dialogue.after(character, parenthetical, nextDialogue);

    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.setStart(character, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      ed.focus({ preventScroll: true } as any);
    }
    ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatOther" }));
    props.scheduleSave?.();
  };

  useEffect(() => {
    const onSetEchoStart = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      if (detail?.id === effectiveId && rightClickTextOffsetRef.current != null) {
        echoStartTextOffsetRef.current = rightClickTextOffsetRef.current;
        const paragraphIndex = rightClickParagraphIndexRef.current;
        echoMarkerParagraphIndexRef.current = paragraphIndex;
        setEchoMarkerParagraphIndex(paragraphIndex);
      }
    };
    window.addEventListener("sw:echo:set-start", onSetEchoStart);
    return () => window.removeEventListener("sw:echo:set-start", onSetEchoStart);
  }, [effectiveId]);

  const getPlainText = () => {
    const ed = edRef.current!;
    const frag = document.createDocumentFragment();
    Array.from(ed.childNodes).forEach(n => frag.appendChild(n.cloneNode(true)));
    return fragmentToPlainText(frag);
  };

  const [typingMode, setTypingMode] = React.useState<{ bold: boolean; italic: boolean }>({
    bold: false, italic: false,
  });
  const [hasTextSelection, setHasTextSelection] = React.useState(false);
  const typingModeRef = useRef<InlineStyleState>({ bold: false, italic: false });
  const caretFormatOverrideRef = useRef<{ textOffset: number; state: InlineStyleState } | null>(null);
  const pendingInputFormatRef = useRef<{ start: number; state: InlineStyleState } | null>(null);
  const compositionFormatRef = useRef<{ start: number; state: InlineStyleState } | null>(null);
  const refreshTyping = () => {
    try {
      const ed = edRef.current;
      const range = ed ? selectionRangeIn(ed) : null;
      if (range && !range.collapsed) {
        setHasTextSelection(range.toString().length > 0);
        caretFormatOverrideRef.current = null;
        const nodes = selectedTextNodes(ed!, range);
        const next = {
          bold: nodes.length > 0 && nodes.every((node) => isInlineFormatActive(node, "bold")),
          italic: nodes.length > 0 && nodes.every((node) => isInlineFormatActive(node, "italic")),
        };
        typingModeRef.current = next;
        setTypingMode(next);
      } else {
        setHasTextSelection(false);
        const override = caretFormatOverrideRef.current;
        if (range?.collapsed && ed && override &&
          override.textOffset === textOffsetAt(ed, range.startContainer, range.startOffset)) {
          typingModeRef.current = override.state;
          setTypingMode(override.state);
          return;
        }
        caretFormatOverrideRef.current = null;
        const node = range?.startContainer as Text | HTMLElement | undefined;
        const next = {
          bold: !!node && isInlineFormatActive(node, "bold"),
          italic: !!node && isInlineFormatActive(node, "italic"),
        };
        typingModeRef.current = next;
        setTypingMode(next);
      }
    } catch {}
  };

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    const onSelectionChange = () => {
      if (!selectionRangeIn(ed)) return;
      requestAnimationFrame(() => refreshTyping());
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const toolbarH = Number.isFinite(TOOLBAR_H as any) ? (TOOLBAR_H as number) : 28;
  const S = getStyles({
    color: props.color,
    inset: (props.inset || {}) as Inset,
    toolbarH,
  });

  const [twOn, setTwOn] = React.useState(false);
  const [spellOn, setSpellOn] = React.useState(false);
  const spellOnRef = useRef(spellOn);
  spellOnRef.current = spellOn;

  // Sync twOn/spellOn states to DOM attributes
  useEffect(() => {
    const wrap = wrapRef.current;
    const ed   = edRef.current;
    if (wrap) {
      if (twOn) wrap.setAttribute("data-typewriter", "1");
      else wrap.removeAttribute("data-typewriter");
    }
    if (ed) ed.setAttribute("spellcheck", spellOn ? "true" : "false");
    if (spellOn) updateSpellScope();
    else clearSpellScope();
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

  const updateEchoMarkerPosition = React.useCallback(() => {
    const ed = edRef.current;
    const editorCol = editorColRef.current;
    const paragraphIndex = echoMarkerParagraphIndexRef.current;
    if (!ed || !editorCol || paragraphIndex == null) {
      setEchoMarkerPosition(null);
      return;
    }

    const paragraphs = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));
    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph) {
      setEchoMarkerPosition(null);
      return;
    }

    const paragraphRect = paragraph.getBoundingClientRect();
    let textRect: DOMRect | null = null;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      if (!textNode.data.length) continue;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(textNode.data.length, Array.from(textNode.data)[0]?.length || 1));
      textRect = range.getBoundingClientRect();
      if (textRect.height > 0) break;
      textRect = null;
    }

    const colRect = editorCol.getBoundingClientRect();
    const targetRect = textRect || paragraphRect;
    const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight) || 18;
    const targetHeight = targetRect.height || lineHeight;
    const dotSize = 7;
    const next = {
      left: (textRect ? targetRect.left : paragraphRect.left) - colRect.left - 10,
      top: targetRect.top - colRect.top + (targetHeight - dotSize) / 2,
    };
    setEchoMarkerPosition((previous) => previous &&
      Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5
      ? previous
      : next
    );
  }, []);

  React.useEffect(() => {
    if (echoMarkerParagraphIndex == null) {
      setEchoMarkerPosition(null);
      return;
    }
    const ed = edRef.current;
    const scroller = scrollerRef.current;
    const editorCol = editorColRef.current;
    if (!ed || !scroller || !editorCol) return;

    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateEchoMarkerPosition();
      });
    };
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    ed.addEventListener("input", scheduleUpdate, true);
    ed.addEventListener("compositionend", scheduleUpdate, true);

    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(ed, { subtree: true, childList: true, characterData: true });
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(editorCol);
    scheduleUpdate();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      ed.removeEventListener("input", scheduleUpdate, true);
      ed.removeEventListener("compositionend", scheduleUpdate, true);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [echoMarkerParagraphIndex, updateEchoMarkerPosition]);

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
  const TW_RANGE_TOP = 0.56;
  const TW_RANGE_BOTTOM = 0.60;

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

    const height = scroller.clientHeight;
    const rangeTop = height * TW_RANGE_TOP;
    const rangeBottom = height * TW_RANGE_BOTTOM;
    if (caretY >= rangeTop && caretY <= rangeBottom) return;

    // Keep the 58% position as the recovery point, but leave the caret free
    // inside a wider band so small per-keystroke changes do not scroll.
    const target = height * TW_TARGET;
    const delta = caretY - target;

    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    let next = scroller.scrollTop + delta;
    if (next < 0) next = 0;
    if (next > maxScroll) next = maxScroll;
    scroller.scrollTop = next;
  }

  function keepCaretAboveBottomEdge() {
    if (twOn) return;
    const scroller = scrollerRef.current;
    const sel = window.getSelection?.();
    if (!scroller || !sel || !sel.rangeCount) return;

    const rect = getCaretRectFromSelection(sel);
    if (!rect) return;
    const view = scroller.getBoundingClientRect();
    const margin = Math.min(28, Math.max(16, scroller.clientHeight * 0.035));
    const overflow = rect.bottom - (view.bottom - margin);
    if (overflow <= 0) return;

    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(max, scroller.scrollTop + overflow);
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
      let textOffset = echoStartTextOffsetRef.current;
      if (textOffset == null && sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        if (ed.contains(r.startContainer)) {
          textOffset = textOffsetAt(ed, r.startContainer, r.startOffset);
        }
      }
      const startParagraphIndex = echoMarkerParagraphIndexRef.current;
      const startAtByMode = { SMART: startAt, ENTER: startAt };
      if (startParagraphIndex != null) {
        // “Set Echo View Start Here” is a paragraph-level anchor: begin at the
        // first sentence in that paragraph, regardless of the clicked character.
        for (let index = 0; index < Math.min(startParagraphIndex, paras.length); index++) {
          const paragraphText = paras[index].innerText || paras[index].textContent || "";
          startAtByMode.SMART += countEchoChunks(paragraphText, "SMART");
          startAtByMode.ENTER += countEchoChunks(paragraphText, "ENTER");
        }
      } else if (textOffset != null) {
        let consumed = 0;
        for (const p of paras) {
          const text = p.textContent || "";
          if (textOffset <= consumed + text.length) {
            startAt += countEndedBefore(text, Math.max(0, textOffset - consumed));
            break;
          }
          startAt += tokenCountOfParagraphText(text);
          consumed += text.length;
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
      setEchoStartAtByMode({
        SMART: Math.max(0, startAtByMode.SMART),
        ENTER: Math.max(0, startAtByMode.ENTER),
      });

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
      setEchoStartAtByMode({ SMART: 0, ENTER: 0 });
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
    const onCompStart = () => {
      pendingInputFormatRef.current = null;
      const range = selectionRangeIn(ed);
      if (!range) {
        compositionFormatRef.current = null;
        return;
      }
      compositionFormatRef.current = {
        start: textOffsetAt(ed, range.startContainer, range.startOffset),
        state: { ...typingModeRef.current },
      };
    };
    const onBeforeInput = (event: InputEvent) => {
      if (
        event.isComposing || compositionFormatRef.current ||
        !/^insert(Text|ReplacementText)$/.test(event.inputType || "")
      ) {
        pendingInputFormatRef.current = null;
        return;
      }
      const range = selectionRangeIn(ed);
      if (!range) {
        pendingInputFormatRef.current = null;
        return;
      }
      const override = caretFormatOverrideRef.current;
      const rangeStart = textOffsetAt(ed, range.startContainer, range.startOffset);
      const state = override && range.collapsed && override.textOffset === rangeStart
        ? override.state
        : typingModeRef.current;
      pendingInputFormatRef.current = { start: rangeStart, state: { ...state } };
    };
    const onInput = (nativeEvent: Event) => {
      const event = nativeEvent as InputEvent;
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      if (!event.isComposing && /^insert(Text|ReplacementText)$/.test(event.inputType || "")) {
        normalizeNativeEmphasisAtCaret(ed);
      }
      const pending = pendingInputFormatRef.current;
      pendingInputFormatRef.current = null;
      let corrected = false;
      if (
        pending && !event.isComposing && !compositionFormatRef.current &&
        /^insert(Text|ReplacementText)$/.test(event.inputType || "")
      ) {
        const range = selectionRangeIn(ed);
        if (range?.collapsed) {
          const end = textOffsetAt(ed, range.startContainer, range.startOffset);
          if (end > pending.start && !textRangeHasInlineState(ed, pending.start, end, pending.state)) {
            applyInlineStateToTextRange(ed, pending.start, end, pending.state);
            const caret = textPointAt(ed, end, "end");
            if (caret) {
              const restored = document.createRange();
              restored.setStart(caret.node, caret.offset);
              restored.collapse(true);
              const selection = window.getSelection?.();
              selection?.removeAllRanges();
              selection?.addRange(restored);
            }
            corrected = true;
          }
          const active = window.getSelection?.();
          if (active?.rangeCount && active.isCollapsed) {
            const caretRange = active.getRangeAt(0);
            caretFormatOverrideRef.current = {
              textOffset: textOffsetAt(ed, caretRange.startContainer, caretRange.startOffset),
              state: pending.state,
            };
          }
          typingModeRef.current = pending.state;
          setTypingMode(pending.state);
        }
      }
      props.onChange?.(ed.innerHTML);
      if (corrected) props.scheduleSave?.();
      goal.bumpGoal();
      requestAnimationFrame(() => refreshTyping());
    };
    const onCompEnd = () => {
      normalizeNativeEmphasisAtCaret(ed);
      const composing = compositionFormatRef.current;
      compositionFormatRef.current = null;
      pendingInputFormatRef.current = null;
      const selection = window.getSelection?.();
      const range = selectionRangeIn(ed);
      if (composing && range?.collapsed) {
        const end = textOffsetAt(ed, range.startContainer, range.startOffset);
        if (end > composing.start) {
          // Do not rebuild the paragraph after every IME commit. Besides being
          // unnecessary when the composition already has the requested style,
          // replacing its DOM here can invalidate native IME actions such as
          // the Korean consonant-to-symbol candidate list.
          if (!textRangeHasInlineState(ed, composing.start, end, composing.state)) {
            applyInlineStateToTextRange(ed, composing.start, end, composing.state);
            const caret = textPointAt(ed, end, "end");
            if (caret && selection) {
              const restored = document.createRange();
              restored.setStart(caret.node, caret.offset);
              restored.collapse(true);
              selection.removeAllRanges();
              selection.addRange(restored);
            }
          }
          caretFormatOverrideRef.current = { textOffset: end, state: composing.state };
          typingModeRef.current = composing.state;
          setTypingMode(composing.state);
        }
      }
      props.onChange?.(ed.innerHTML);
      props.scheduleSave?.();
      goal.bumpGoal();
      requestAnimationFrame(() => refreshTyping());
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      if (!text) return;
      restoreRecentClickCaretIfSafe();
      markHistoryBoundary(ed);
      insertPlainTextStrict(ed, text);
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDrop" }));
      props.scheduleSave?.();
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
    };

    ed.addEventListener("beforeinput", onBeforeInput, true);
    ed.addEventListener("input", onInput, true);
    ed.addEventListener("compositionstart", onCompStart, true);
    ed.addEventListener("compositionend", onCompEnd, true);
    ed.addEventListener("drop", onDrop, true);
    return () => {
      ed.removeEventListener("beforeinput", onBeforeInput, true);
      ed.removeEventListener("input", onInput, true);
      ed.removeEventListener("compositionstart", onCompStart, true);
      ed.removeEventListener("compositionend", onCompEnd, true);
      ed.removeEventListener("drop", onDrop, true);
    };
  }, [props.onChange, props.scheduleSave]);

  // Strict paragraph model: Enter creates exactly one root-level paragraph.
  useEffect(() => {
    const ed = edRef.current!;
    if (!ed) return;

    const onBeforeInput = (e: InputEvent) => {
      if ((e as any).isComposing) return;
      const inputType = (e as any).inputType;
      if (inputType === "insertParagraph") {
        e.preventDefault();
        e.stopPropagation();
        const range = selectionRangeIn(ed);
        if (!range || !closestParagraph(range.startContainer)) return;
        markHistoryBoundary(ed);
        if (!insertParagraphBreakStrict(ed)) return;
        // Typing emphasis is local to the current paragraph. Keep a false
        // override at the new caret so browser command state cannot leak the
        // previous paragraph's bold/italic mode across the split.
        const newRange = selectionRangeIn(ed);
        if (newRange?.collapsed) {
          const plain: InlineStyleState = { bold: false, italic: false };
          const offset = textOffsetAt(ed, newRange.startContainer, newRange.startOffset);
          caretFormatOverrideRef.current = { textOffset: offset, state: plain };
          typingModeRef.current = plain;
          setTypingMode(plain);
          emitHud(plain);
        }
      } else if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
        const range = selectionRangeIn(ed);
        const p = range ? closestParagraph(range.startContainer) : null;
        if (!range || !p) return;
        const edge = inputType === "deleteContentBackward" ? "start" : "end";
        if (!caretAtParagraphBoundary(p, range, edge)) return;
        e.preventDefault();
        e.stopPropagation();
        const adjacent = inputType === "deleteContentBackward" ? p.previousElementSibling : p.nextElementSibling;
        if (!adjacent?.matches(PSEL)) return;
        markHistoryBoundary(ed);
        if (!joinParagraphAtBoundary(p, inputType === "deleteContentBackward" ? "backward" : "forward")) return;
        ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
      } else {
        return;
      }
      if (lastClickPointRef.current) lastClickPointRef.current.dirty = true;
      props.scheduleSave?.();
      props.onChange?.(ed.innerHTML);
      goal.bumpGoal();
      if (twRef.current) {
        requestAnimationFrame(() => nudgeTypewriter(true));
      } else if (inputType === "insertParagraph") {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!twRef.current) keepCaretAboveBottomEdge();
        }));
      }
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
    if (!ed || !spellOnRef.current) return;
    const paras = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));
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

  function clearSpellScope() {
    const ed = edRef.current;
    if (!ed) return;
    ed.querySelectorAll<HTMLElement>(PSEL).forEach(p => {
      p.removeAttribute("spellcheck");
      p.style.opacity = "";
      p.removeAttribute("data-spell-skip");
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

  // With Typewriter off, only follow the caret when it approaches the bottom
  // edge. This leaves the normal reading position alone until the active line
  // would otherwise disappear below the editor viewport.
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || twOn) return;

    let frame = 0;
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        keepCaretAboveBottomEdge();
      });
    };

    ed.addEventListener("input", schedule, true);
    ed.addEventListener("compositionend", schedule, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ed.removeEventListener("input", schedule, true);
      ed.removeEventListener("compositionend", schedule, true);
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
    if (!targets.length) return false;
    markHistoryBoundary(ed);
    targets.forEach((p) => applyPresetToParagraph(p, preset));
    ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatPreset" }));
    emitHud({ preset });
    props.scheduleSave?.();
    props.onChange?.(ed.innerHTML);
    return true;
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
    if (!targets.length) return;
    markHistoryBoundary(ed);
    targets.forEach((p) => (p.style.textAlign = kind === "justify" ? "justify" : kind));
    ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatAlign" }));
    props.scheduleSave?.();
    props.onChange?.(ed.innerHTML);
  };

  const toggleInlineFormat = (format: InlineFormat) => {
    const ed = edRef.current!;
    restoreRecentClickCaretIfSafe();
    const range = selectionRangeIn(ed);
    if (!range) {
      focus();
      return;
    }

    if (range.collapsed) {
      setHasTextSelection(false);
      refreshTyping();
      return;
    }

    caretFormatOverrideRef.current = null;
    const nodes = selectedTextNodes(ed, range);
    if (!range.toString().length) return;
    const enabled = nodes.length === 0 || !nodes.every((node) => isInlineFormatActive(node, format));
    markHistoryBoundary(ed);
    if (!applyInlineFormatToSelection(ed, format, enabled)) return;
    ed.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: format === "bold" ? "formatBold" : "formatItalic",
    }));
    props.scheduleSave?.();
    props.onChange?.(ed.innerHTML);
    refreshTyping();
    emitHud(typingModeRef.current);
  };

  const toggleBold = () => toggleInlineFormat("bold");
  const toggleItalic = () => toggleInlineFormat("italic");

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

      if (/^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(key || "")) {
        requestAnimationFrame(() => refreshTyping());
      }

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
            const removed = removeLeadingTabFromParagraph(p, () => markHistoryBoundary(ed));
            if (removed) {
              ensureParagraphMarkersNearCaret(ed);
              ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
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
        if (code === "KeyB" || lower === "b") {
          ev.preventDefault(); ev.stopPropagation();
          if (!selectionRangeIn(ed)?.collapsed && selectionRangeIn(ed)?.toString().length) toggleBold();
          return;
        }
        if (code === "KeyI" || lower === "i") {
          ev.preventDefault(); ev.stopPropagation();
          if (!selectionRangeIn(ed)?.collapsed && selectionRangeIn(ed)?.toString().length) toggleItalic();
          return;
        }
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

          // Recheck after the new paragraph and caret have reached layout.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            nudgeTypewriter(true);

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
      markHistoryBoundary(ed);
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
      // Copy each editor paragraph as one plain-text line break. The default
      // paragraph spacing remains available to internal text extraction.
      const text = fragmentToPlainText(frag, "\n");

      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };

    ed.addEventListener("copy", onCopy as any);
    return () => ed.removeEventListener("copy", onCopy as any);
  }, []);

  /* ---- Undo/Redo + Curly replacement ---- */
  useEffect(() => {
    const ed = edRef.current!;
    const ctl = attachUndoCurly(ed, {
      boardId: effectiveId,
      limit: 50,
      curly: () => curlySettingRef.current,
      hooks: {
        scheduleSave: props.scheduleSave,
        onChange: (html) => {
          onChangeRef.current?.(html);
          bumpGoalRef.current();
        },
      },
    });
    return () => ctl.destroy();
  }, [effectiveId, props.scheduleSave]);

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
      if (isDrag) {
        requestAnimationFrame(() => refreshTyping());
        return;
      }

      // v5: TextBoard deliberately does not support browser double-click word selection.
      // Any non-drag LMB release is treated as a plain caret placement.
      // This keeps accidental double-clicks from leaving a word selection or stale range
      // that can corrupt the next paste/preset command.
      const anchoredNow = placeCaretFromPointInEditor(ed, pt.x, pt.y);
      if (anchoredNow) {
        lastClickPointRef.current = { x: pt.x, y: pt.y, t: performance.now(), dirty: false };
      }
      requestAnimationFrame(() => refreshTyping());

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
      let pointRange: Range | null = null;
      const doc = ed.ownerDocument as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      try {
        pointRange = doc.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
        if (!pointRange) {
          const point = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
          if (point) {
            pointRange = doc.createRange();
            pointRange.setStart(point.offsetNode, point.offset);
            pointRange.collapse(true);
          }
        }
      } catch {}
      const pointIsInsideEditor = !!pointRange && ed.contains(pointRange.startContainer);
      const activeRange = selectionRangeIn(ed);
      const rangeForOffset = pointIsInsideEditor
        ? pointRange
        : activeRange?.collapsed ? activeRange : null;
      rightClickTextOffsetRef.current = rangeForOffset
        ? textOffsetAt(ed, rangeForOffset.startContainer, rangeForOffset.startOffset)
        : null;

      const hit = doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const hitParagraph = hit?.closest(PSEL) as HTMLElement | null;
      const pointParagraph = pointIsInsideEditor && pointRange
        ? closestParagraph(pointRange.startContainer)
        : null;
      const activeParagraph = activeRange?.collapsed
        ? closestParagraph(activeRange.startContainer)
        : null;
      const eventParagraph = closestParagraph(e.target as Node);
      const targetParagraph = eventParagraph ||
        (hitParagraph && ed.contains(hitParagraph) ? hitParagraph : null) ||
        pointParagraph || activeParagraph;
      const paragraphs = Array.from(ed.querySelectorAll<HTMLElement>(PSEL));
      const paragraphIndex = targetParagraph ? paragraphs.indexOf(targetParagraph) : -1;
      rightClickParagraphIndexRef.current = paragraphIndex >= 0 ? paragraphIndex : null;

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
      data-board-kind={props.scenario ? "scenario" : "text"}
      data-typewriter={twOn ? "1" : undefined} 
      style={{ ...S.wrap, WebkitAppRegion: "no-drag" as any, ...(props.scenario ? {
        "--scenario-format-width": `${scenarioFormatWidth}%`,
        "--scenario-character-width": `${Math.round(scenarioFormatWidth * 0.64)}%`,
        "--scenario-parenthetical-width": `${Math.round(scenarioFormatWidth * 0.54)}%`,
      } as React.CSSProperties : {}) }}
    >
      {createPortal(<WindowResizeEdges />, document.body)}
      <EchoReader
        open={echoOpen}
        onClose={() => setEchoOpen(false)}
        text={echoText}
        startAt={echoStartAt}
        startAtByMode={echoStartAtByMode}
        preset={2}
        typefaces={props.typefaces}
        accentColor={props.accentColor}
        bgSources={echoBgSources} 
      />
      <div style={S.toolbarBox}>
        <TextToolbar
          typingMode={typingMode}
          hasTextSelection={hasTextSelection}
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
                  hitColor: props.accentColor || "var(--accent)",
                }
              : undefined
          }
          scenarioWidth={props.scenario ? { value: scenarioFormatWidth, onChange: setScenarioFormatWidth } : undefined}
        />
      </div>
      <div style={S.divider} onPointerDown={onFocusZonePointerDown} />

      <div
        style={{ ...S.editorWrap, overflowAnchor: twOn ? "none" as any : "auto" as any }}
        ref={scrollerRef}
        onPointerDown={onFocusZonePointerDown}
      >
        <div ref={editorColRef} style={{ ...S.editorCol, overflowAnchor: twOn ? "none" as any : "auto" as any }}>
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
          {props.scenario && scenarioDialogueAnchors.map((anchor) => (
            <button
              key={anchor.index}
              type="button"
              className="scenario-add-dialogue"
              aria-label="Add character and dialogue"
              title="Add character and dialogue"
              style={{ left: anchor.left, top: anchor.top }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={() => addScenarioDialogue(anchor.index)}
            >
              +
            </button>
          ))}
          {echoMarkerPosition && <span
            title="Echo View starts here"
            aria-label="Echo View start"
            style={{
              position: "absolute",
              left: echoMarkerPosition.left,
              top: echoMarkerPosition.top,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: props.accentColor || "var(--accent)",
              boxShadow: "0 0 0 2px var(--bg)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          />}
          <div ref={spacerRef} style={{ height: 0, pointerEvents: "none" }} />
        </div>
      </div>
    </div>
  );
});
