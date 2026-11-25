// src/windows/MainUI.tsx
/**
 * Splitwriter 메인 UI 컴포넌트.
 *
 * - 전체 레이아웃과 보드 트리(SplitPane), 사이드바/프리셋/각종 모달을 묶어서
 *   하나의 화면으로 오케스트레이션하는 최상위 UI 레이어다.
 * - 단축키(Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+N / Ctrl+R / F5 등)와
 *   창 종료/리로드/자동저장 같은 전역 행동을 여기에서 정의한다.
 *
 * ★ 중요한 규칙 (파일 관련):
 * - 프로젝트 저장/다른 이름으로 저장/열기/새로 만들기/리로드/종료 같은
 *   모든 “파일 관련 명령”은 반드시 runtime/appActions.ts를 통해서만 동작해야 한다.
 *   └ save / saveAsAndBind / openWithGuard / newWithGuard / reloadWithGuard / quitWithGuard 사용
 * - 이 컴포넌트 안에서는 파일 경로나 디스크 I/O를 직접 만지지 않고,
 *   appActions + Swon IO가 제공하는 인터페이스만 호출하는 것을 원칙으로 한다.
 * - 새로 파일 단축키나 메뉴가 추가될 때도
 *   여기서 로직을 구현하지 말고 appActions에 함수를 먼저 추가한 뒤 그 함수를 호출한다.
 */
import React, { useRef, useState } from "react";
import { setupSwonIO, type SwonImage, type SwonWindowState } from "./swon";
import { listen } from "@tauri-apps/api/event";
import {
  initAppActions,
  openWithGuard,
  openByPath,
  save,
  saveAsAndBind,
  // reloadWithGuard,
  newWithGuard,
  quitWithGuard,
  noteCurrentFile, 
  updateTitleFromStatus,
} from "./runtime/appActions";

/* ---------------- Panes ---------------- */
import SplitPane from "./panes/SplitPane";
import LeafPane from "./panes/LeafPane";

/* ---------------- Chrome ---------------- */
import TitleBar from "./ui/TitleBar";
import TopBar from "./ui/TopBar";

/* ---------------- Boards ---------------- */
import TextBoard, { type TextBoardHandle } from "./boards/TextBoard";
import ImageBoard, { type ImageBoardHandle } from "./boards/ImageBoard";
import ViewerBoard, { type ViewerBoardHandle } from "./boards/ViewerBoard";
import EditBoard from "./boards/EditBoard";
import NavigatorBoard, { type NavigatorTextItem } from "./boards/NavigatorBoard";
import ManuscriptBoard from "./boards/ManuscriptBoard";

/* ---------------- Overlays ---------------- */
import Sidebar from "./overlay/Sidebar";
import PreferenceModal from "./overlay/Preferences";
import { DEFAULT_PREFS, normalizeParagraphIndent, type Preferences as PrefsType } from "../shared/defaultPrefs";
import { normalizeInputLocaleId } from "./runtime/locale";
import { applyAccentTokens } from "./runtime/accent";
import { applyInputLocaleDom } from "./runtime/applyLocale";
import ContextMenu from "./ui/contextmenu/ContextMenu";

/* ---------------- Default_Preset ---------------- */
const PREFS_STORAGE_KEY = "splitwriter:preferences:v4";
const PREFS_WF_KEY        = "splitwriter:workingFolder";   
const TRANSIENT_DIRTY_MARKUP = /data-(?:sel|caret|sw-sel|sw-caret|zw)\b|data-role\s*=\s*["']sel-keeper["']|[\u200B\u200C\u200D\uFEFF]/i;
// Set true temporarily to allow F12 / Ctrl+Shift+I during local debugging.
// Release builds also need Cargo's optional `devtools-debug` feature.
const DEVTOOLS_SHORTCUTS_ENABLED = true;

/* ---------------- Exporters ---------------- */
import { printHTML } from "./runtime/exporters/printExport";
import { htmlToPlainText } from "./runtime/plainText";

function whitelistPrefsMerge(defaults: PrefsType, raw: any): PrefsType {
  const out: any = { ...defaults };
  if (!raw || typeof raw !== "object") return out;

  // Typeface
  const tf = raw.typeface || raw.typefaces;
  if (tf) {
    const fill = (src: any, base: any) => (src && typeof src === "object") ? { ...base, ...src } : base;
    out.typeface = {
      headline: fill(tf.headline, defaults.typeface.headline),
      body:     fill(tf.body,     defaults.typeface.body),
      accent:   fill(tf.accent,   defaults.typeface.accent),
      etc:      fill(tf.etc ?? tf.etc2, defaults.typeface.etc),
    };
  }

  // Whitelist of allowed option keys
  if ("accentColor" in raw) out.accentColor = String(raw.accentColor || defaults.accentColor);
  if ("paragraphIndent" in raw) out.paragraphIndent = normalizeParagraphIndent(raw.paragraphIndent);
  if ("inputLocale" in raw) out.inputLocale = normalizeInputLocaleId(raw.inputLocale);
  if ("manuscriptGapLines" in raw) {
    const lines = Number(raw.manuscriptGapLines);
    if (Number.isInteger(lines) && lines >= 0 && lines <= 50) out.manuscriptGapLines = lines;
  }
  if ("language"    in raw) out.language    = raw.language || defaults.language;
  if ("theme"       in raw) out.theme       = raw.theme || defaults.theme;

  if ("autosave" in raw) out.autosave = !!raw.autosave;
  if ("autosaveIntervalSec" in raw) {
    const n = Number(raw.autosaveIntervalSec);
    if (!Number.isNaN(n) && n >= 5 && n <= 3600) out.autosaveIntervalSec = n;
  }

  if ("writingGoal" in raw && typeof raw.writingGoal === "object")
    out.writingGoal = { ...defaults.writingGoal, ...raw.writingGoal };

  if ("bracket" in raw && typeof raw.bracket === "object")
    out.bracket = { ...defaults.bracket, ...raw.bracket };

  // Accept legacy keys as well
  if ("curly" in raw || "curlyReplace" in raw) (out as any).curly = raw.curly ?? raw.curlyReplace;

  return out as PrefsType;
}

function prefsMatchCurrentSchema(raw: any, normalized: PrefsType): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const expectedKeys = Object.keys(normalized);
  const rawKeys = Object.keys(raw);
  return expectedKeys.length === rawKeys.length
    && expectedKeys.every((key) => key in raw && JSON.stringify(raw[key]) === JSON.stringify((normalized as any)[key]));
}
// --- AppVersion (UI 표기: Tauri면 실제 버전, 웹이면 fallback) ---
const AppVersion: React.FC<{ fallback?: string }> = ({
  fallback = "v2.0-portable",
}) => {
  const [v, setV] = React.useState<string>(fallback);

  React.useEffect(() => {
    (async () => {
      try {
        if ((window as any).__TAURI_IPC__) {
          const { getVersion } = await import("@tauri-apps/api/app");
          const version = "v" + (await getVersion());
          setV(version.replace(/^(v\d+\.\d+)\.0(-portable)$/, "$1$2"));
        }
      } catch {
        /* no-op: fallback 유지 */
      }
    })();
  }, []);

  // 스타일은 밖에서 주기 위해 텍스트만 반환
  return <>{v}</>;
};

function applyPrefsAndPersist(next: PrefsType, notify: (msg: string)=>void) {
  const toStore: any = { ...next };
  const wf = String((next as any).workingFolder || "");
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(toStore));
    if (wf) localStorage.setItem(PREFS_WF_KEY, wf); 
  } catch {}


  (window as any).__SW_APPLY_PREFS__({ ...next, workingFolder: wf || next.workingFolder });
  notify("Default preset updated."); // Apply to DOM immediately and persist to storage
}

function emitTextToggle(id: string, type: "typewriter") {
  window.dispatchEvent(new CustomEvent("sw:text:toggle", { detail: { id, type } }));
}

function loadPrefsFromStorage(defaults: PrefsType): PrefsType {
  try {
    const raw   = localStorage.getItem(PREFS_STORAGE_KEY);
    const wfKey = localStorage.getItem(PREFS_WF_KEY);

    // 1) Prefer v4; survive JSON parse failures
    let parsedV4: any = null;
    if (raw) {
      try { parsedV4 = JSON.parse(raw); } catch { parsedV4 = null; }
    }
    if (parsedV4) {
      return {
        ...defaults,
        workingFolder: wfKey ?? parsedV4.workingFolder ?? defaults.workingFolder,
        autosave: parsedV4.autosave ?? defaults.autosave,
        autosaveIntervalSec: parsedV4.autosaveIntervalSec ?? defaults.autosaveIntervalSec,
        typeface: {
          headline: parsedV4.typeface?.headline ?? defaults.typeface.headline,
          body:     parsedV4.typeface?.body     ?? defaults.typeface.body,
          accent:   parsedV4.typeface?.accent   ?? defaults.typeface.accent,
          etc:      parsedV4.typeface?.etc      ?? defaults.typeface.etc,
        },
        paragraphIndent: normalizeParagraphIndent(parsedV4.paragraphIndent),
        accentColor: parsedV4.accentColor ?? defaults.accentColor,
        writingGoal: parsedV4.writingGoal ?? defaults.writingGoal,
        bracket:     parsedV4.bracket     ?? defaults.bracket,
        language:    parsedV4.language    ?? defaults.language,
        theme:       parsedV4.theme       ?? defaults.theme,
      };
    }

    // 2) v2 fallback: only when v4 is missing or corrupt
    const v2 = localStorage.getItem("splitwriter:preferences:v2");
    if (v2) {
      try {
        const p  = JSON.parse(v2);
        const tf = p.typeface || p.fonts || {};
        return {
          ...defaults,
          ...p,
          workingFolder: wfKey ?? p.workingFolder ?? defaults.workingFolder,
          theme: p.theme ?? "dark",
          typeface: {
            headline: tf.headline ?? defaults.typeface.headline,
            body:     tf.body     ?? defaults.typeface.body,
            accent:   tf.accent   ?? defaults.typeface.accent,
            etc:      tf.etc ?? tf.etc2 ?? defaults.typeface.etc,
          },
          paragraphIndent: normalizeParagraphIndent(p.paragraphIndent),
          accentColor: p.accentColor ?? defaults.accentColor,
          bracket: p.bracket ?? defaults.bracket,
          writingGoal: p.writingGoal ?? defaults.writingGoal,
        } as PrefsType;
      } catch { /* ignore → fall back to defaults */ }
    }
  } catch { /* localStorage access failed → fall back to defaults */ }

  // 3) Final fallback: defaults
  return defaults;
}

type SplitDir = "vertical" | "horizontal";

type LeafNode = {
  type: "leaf";
  id: string;
  kind: LeafKind;
  textId: string;
  imageId: string;
  textGroup?: "writing" | "notes";
  writingBoardIds?: string[];
  noteBoardIds?: string[];
  boardNames?: Record<string, string>;
  writingEntries?: NavigatorEntry[];
  writingVariants?: WritingVariant[];
  activeWritingVariantId?: string;
  noteEntries?: NavigatorEntry[];
  mainPaneLeafId?: string;
  mainBoardId?: string;
};

type NavigatorEntry =
  | { type: "board"; id: string }
  | { type: "group"; id: string; name: string; collapsed: boolean; children: string[] };

type WritingVariant = { id: string; name: string; entries: NavigatorEntry[] };

type SplitNode = {
  type: "split";
  dir: SplitDir;
  ratio: number; // 0..1
  a: TreeNode;
  b: TreeNode;
};

type TreeNode = LeafNode | SplitNode;

// ---- Typeface → CSS tokens bridge ----
type TF = { name?: string; size?: number };
type TFTable = { headline?: TF; body?: TF; accent?: TF; etc?: TF };

function applyTypeTokens(t?: TFTable) {
  const r = document.documentElement;
  const set = (k: string, v?: string | number) => {
    if (v == null) return;
    r.style.setProperty(k, typeof v === "number" ? `${v}px` : String(v));
  };

  const h = t?.headline, b = t?.body, a = t?.accent, e = t?.etc;

  // family
  set("--type-h-family", h?.name || "system-ui");
  set("--type-b-family", b?.name || "system-ui");
  set("--type-a-family", a?.name || "system-ui");
  set("--type-e-family", e?.name || "system-ui");

  // size
  if (h?.size) set("--type-h-size", h.size);
  if (b?.size) set("--type-b-size", b.size);
  if (a?.size) set("--type-a-size", a.size);
  if (e?.size) set("--type-e-size", e.size);
}

function applyParagraphIndentTokens(prefs: PrefsType) {
  const root = document.documentElement;
  const context = document.createElement("canvas").getContext("2d");
  const slots = ["headline", "body", "accent", "etc"] as const;
  const indent = normalizeParagraphIndent(prefs.paragraphIndent);
  for (const key of slots) {
    const font = prefs.typeface[key];
    const style = String(font.style || "").toLowerCase();
    const weight = style.includes("black") ? 900
      : style.includes("extra") && style.includes("bold") ? 800
      : style.includes("bold") ? 700
      : style.includes("semibold") || style.includes("demibold") ? 600
      : style.includes("medium") ? 500
      : style.includes("light") ? 300
      : 400;
    let spaceWidth = Math.max(1, Number(font.size) || 16) * .25 * indent.spaces;
    if (context) {
      context.font = `${style.includes("italic") ? "italic " : ""}${weight} ${Number(font.size) || 16}px ${font.name || "system-ui"}`;
      const measured = context.measureText(" ".repeat(indent.spaces)).width;
      if (Number.isFinite(measured) && measured > 0) spaceWidth = measured;
    }
    root.style.setProperty(`--sw-indent-${key}`, indent.enabled && indent[key] ? `${spaceWidth}px` : "0px");
  }
}

type LeafKind = "text" | "scenario" | "image" | "viewer" | "edit" | "navigator" | "manuscript";

type ViewerTextItem = { id: string; html: string; preview: string };
type ViewerState = {
  fileLabel: string;
  boards: ViewerTextItem[];
  selectedId: string;
  q: string;
};

type HistorySnap = {
  tree: TreeNode;
  texts: Record<string, string>;
  images: Record<string, SwonImage>;
  archivedText: Record<string, string>;
  archivedImage: Record<string, SwonImage>;
  selection?: { boardId: string; start: number; end: number };
};

function cloneSnap(s: HistorySnap): HistorySnap {
  return {
    tree: JSON.parse(JSON.stringify(s.tree)),
    texts: { ...s.texts },
    images: JSON.parse(JSON.stringify(s.images)),
    archivedText: { ...s.archivedText },
    archivedImage: JSON.parse(JSON.stringify(s.archivedImage)),
    selection: s.selection ? { ...s.selection } : undefined,
  };
}

declare global {
  interface Window {
    __CTX_TARGET__?: Element | null;
    __SW_CURRENT_FILE__?: string;
  }
}

function getActiveBoardEl(): HTMLElement | null {
  const ctx = (window as any).__CTX_TARGET__ as Element | null;
  if (ctx) return (ctx.closest?.("[data-board-id]") as HTMLElement | null) ?? null;

  const an = window.getSelection()?.anchorNode || null;
  let base: Element | null = null;
  if (an) {
    if (an.nodeType === 1) base = an as Element;       
    else if ((an as any).parentElement) base = (an as any).parentElement as Element; 
    else if (an.parentNode instanceof Element) base = an.parentNode as Element;
  }

  const active = (document.activeElement as Element | null);
  const t = base || active;
  return t?.closest?.("[data-board-id]") as HTMLElement | null;
}

function getBoardState() {
  const el = getActiveBoardEl();
  if (!el) return { id: "", typewriter: false };
  const id = el.getAttribute("data-board-id") || "";
  const typewriter = el.getAttribute("data-typewriter") === "1";
  return { id, typewriter };
}

const uid = (() => {
  let n = 1;
  return () => String(n++);
})();

const makeLeaf = (kind: LeafKind, textGroup?: "writing" | "notes"): LeafNode => ({
  type: "leaf",
  id: uid(),
  kind,
  textId: `T${uid()}`,
  imageId: `I${uid()}`,
  ...(kind === "text" || kind === "scenario" ? { textGroup: textGroup ?? "writing" } : {}),
});

function makeInitialTree(): TreeNode {
  const writing = makeLeaf("text", "writing");
  const notes = makeLeaf("text", "notes");
  const navigator = makeLeaf("navigator");
  navigator.writingBoardIds = [writing.textId];
  navigator.noteBoardIds = [notes.textId];
  navigator.writingEntries = [{ type: "board", id: writing.textId }];
  navigator.writingVariants = [{ id: "main", name: "Main", entries: navigator.writingEntries }];
  navigator.activeWritingVariantId = "main";
  navigator.noteEntries = [{ type: "board", id: notes.textId }];
  navigator.mainPaneLeafId = writing.id;
  navigator.mainBoardId = writing.textId;
  return {
    type: "split",
    dir: "vertical",
    ratio: 0.18,
    a: navigator,
    b: {
      type: "split",
      dir: "vertical",
      ratio: 0.68,
      a: writing,
      b: {
        type: "split",
        dir: "horizontal",
        ratio: 0.5,
        a: notes,
        b: makeLeaf("image"),
      },
    },
  };
}

function updateNavigator(root: TreeNode, navigatorId: string, update: (leaf: LeafNode) => LeafNode): TreeNode {
  if (root.type === "leaf") {
    if (root.id !== navigatorId) return root;
    const updated = update(root);
    const previousActiveId = root.activeWritingVariantId || "main";
    const nextActiveId = updated.activeWritingVariantId || "main";
    if (updated.writingEntries && nextActiveId === previousActiveId && updated.writingEntries !== root.writingEntries) {
      const variants = writingVariantsForLeaf(root).map((variant) => variant.id === nextActiveId
        ? { ...variant, entries: updated.writingEntries! }
        : variant);
      return { ...updated, activeWritingVariantId: nextActiveId, writingVariants: variants };
    }
    return updated;
  }
  return {
    ...root,
    a: updateNavigator(root.a, navigatorId, update),
    b: updateNavigator(root.b, navigatorId, update),
  };
}

function addNavigatorBoard(root: TreeNode, navigatorId: string, group: "writing" | "notes", boardId: string): TreeNode {
  // Older SWON files may not have persisted Navigator entries yet. Their boards
  // are still represented by text leaves, so seed the order from those leaves
  // before appending a new board instead of replacing the legacy fallback list.
  const legacyBoardIds = collectTextLeaves(root)
    .filter((item) => group === "writing"
      ? (item.textGroup ?? "writing") === "writing"
      : item.textGroup === "notes")
    .map((item) => item.textId);
  return updateNavigator(root, navigatorId, (leaf) => {
    if (group === "writing") {
      const activeId = leaf.activeWritingVariantId || "main";
      let currentVariants = writingVariantsForLeaf(leaf);
      const hasRegisteredBoards = currentVariants.some((variant) => flattenNavigatorBoardIds(variant.entries).length > 0);
      if (!hasRegisteredBoards && legacyBoardIds.length) {
        const main = currentVariants.find((variant) => variant.id === "main");
        const seededMain: WritingVariant = {
          ...(main || { id: "main", name: "Main", entries: [] }),
          entries: legacyBoardIds.map((id) => ({ type: "board" as const, id })),
        };
        currentVariants = [seededMain, ...currentVariants.filter((variant) => variant.id !== "main")];
      }
      const main = currentVariants.find((variant) => variant.id === "main") || currentVariants[0];
      // Board membership is shared across order variants. Reconcile older or
      // partially stale variants from Main, preserving each one's existing order
      // and appending any missing boards at its end.
      const sharedBoardIds = [...new Set([
        ...flattenNavigatorBoardIds(main?.entries || []),
        ...currentVariants.flatMap((variant) => flattenNavigatorBoardIds(variant.entries)),
        boardId,
      ])];
      const variants = currentVariants.map((variant) => {
        const existingIds = new Set(flattenNavigatorBoardIds(variant.entries));
        const missing = sharedBoardIds.filter((id) => !existingIds.has(id));
        return {
          ...variant,
          entries: [...variant.entries, ...missing.map((id) => ({ type: "board" as const, id }))],
        };
      });
      const active = variants.find((variant) => variant.id === activeId) || variants[0];
      const entries = active?.entries || [{ type: "board" as const, id: boardId }];
      return {
        ...leaf,
        writingBoardIds: flattenNavigatorBoardIds(entries),
        writingEntries: entries,
        writingVariants: variants,
        activeWritingVariantId: activeId,
        ...(leaf.mainBoardId && flattenNavigatorBoardIds(entries).includes(leaf.mainBoardId) ? {} : { mainBoardId: flattenNavigatorBoardIds(entries)[0] }),
      };
    }
    const storedEntries = navigatorEntriesForLeaf(leaf, group);
    const entries = storedEntries.length || !legacyBoardIds.length
      ? storedEntries
      : legacyBoardIds.map((id) => ({ type: "board" as const, id }));
    const nextEntries = [...entries, { type: "board" as const, id: boardId }];
    return { ...leaf, noteBoardIds: flattenNavigatorBoardIds(nextEntries), noteEntries: nextEntries };
  });
}

function writingVariantsForLeaf(leaf: LeafNode): WritingVariant[] {
  const variants = leaf.writingVariants?.length
    ? leaf.writingVariants
    : [{ id: "main", name: "Main", entries: leaf.writingEntries || (leaf.writingBoardIds || []).map((id) => ({ type: "board" as const, id })) }];
  const main = variants.find((variant) => variant.id === "main") || variants[0];
  const sharedBoardIds = [...new Set([
    ...flattenNavigatorBoardIds(main?.entries || []),
    ...variants.flatMap((variant) => flattenNavigatorBoardIds(variant.entries)),
  ])];
  return variants.map((variant) => {
    const existingIds = new Set(flattenNavigatorBoardIds(variant.entries));
    const missing = sharedBoardIds.filter((id) => !existingIds.has(id));
    return missing.length
      ? { ...variant, entries: [...variant.entries, ...missing.map((id) => ({ type: "board" as const, id }))] }
      : variant;
  });
}

function navigatorEntriesForLeaf(leaf: LeafNode, group: "writing" | "notes"): NavigatorEntry[] {
  if (group === "writing") {
    const variants = writingVariantsForLeaf(leaf);
    const active = variants.find((variant) => variant.id === (leaf.activeWritingVariantId || "main")) || variants[0];
    if (active) return active.entries;
  }
  const entries = group === "writing" ? leaf.writingEntries : leaf.noteEntries;
  if (entries) return entries;
  const ids = group === "writing" ? leaf.writingBoardIds : leaf.noteBoardIds;
  return (ids || []).map((id) => ({ type: "board", id }));
}

function createWritingVariant(root: TreeNode, navigatorId: string): { tree: TreeNode; id: string } {
  let createdId = "";
  const tree = updateNavigator(root, navigatorId, (leaf) => {
    const variants = writingVariantsForLeaf(leaf);
    const main = variants.find((variant) => variant.id === "main") || variants[0];
    const nextNumber = Math.max(0, ...variants.map((variant) => Number(variant.name.match(/^Draft\s+(\d+)$/i)?.[1] || 0))) + 1;
    createdId = `draft-${uid()}`;
    const name = `Draft ${String(nextNumber).padStart(2, "0")}`;
    const entries = JSON.parse(JSON.stringify(main?.entries || [])) as NavigatorEntry[];
    const nextVariants = [...variants, { id: createdId, name, entries }];
    return {
      ...leaf,
      writingVariants: nextVariants,
      activeWritingVariantId: createdId,
      writingEntries: entries,
      writingBoardIds: flattenNavigatorBoardIds(entries),
    };
  });
  return { tree, id: createdId };
}

function selectWritingVariant(root: TreeNode, navigatorId: string, variantId: string): TreeNode {
  return updateNavigator(root, navigatorId, (leaf) => {
    const variants = writingVariantsForLeaf(leaf);
    const selected = variants.find((variant) => variant.id === variantId);
    if (!selected) return leaf;
    return {
      ...leaf,
      writingVariants: variants,
      activeWritingVariantId: selected.id,
      writingEntries: selected.entries,
      writingBoardIds: flattenNavigatorBoardIds(selected.entries),
    };
  });
}

function renameWritingVariant(root: TreeNode, navigatorId: string, variantId: string, name: string): TreeNode {
  const trimmed = name.trim();
  if (!trimmed) return root;
  return updateNavigator(root, navigatorId, (leaf) => ({
    ...leaf,
    writingVariants: writingVariantsForLeaf(leaf).map((variant) => variant.id === variantId ? { ...variant, name: trimmed } : variant),
  }));
}

function deleteWritingVariant(root: TreeNode, navigatorId: string, variantId: string): TreeNode {
  if (variantId === "main") return root;
  return updateNavigator(root, navigatorId, (leaf) => {
    const variants = writingVariantsForLeaf(leaf).filter((variant) => variant.id !== variantId);
    const active = leaf.activeWritingVariantId === variantId
      ? (variants.find((variant) => variant.id === "main") || variants[0])
      : variants.find((variant) => variant.id === (leaf.activeWritingVariantId || "main"));
    return {
      ...leaf,
      writingVariants: variants,
      activeWritingVariantId: active?.id || "main",
      writingEntries: active?.entries || [],
      writingBoardIds: flattenNavigatorBoardIds(active?.entries || []),
    };
  });
}

function removeNavigatorBoard(root: TreeNode, navigatorId: string, group: "writing" | "notes", boardId: string): TreeNode {
  const removeFromEntries = (entries: NavigatorEntry[]) => entries.flatMap<NavigatorEntry>((entry) => {
    if (entry.type === "board") return entry.id === boardId ? [] : [entry];
    const children = entry.children.filter((id) => id !== boardId);
    return children.length ? [{ ...entry, children }] : [];
  });
  return updateNavigator(root, navigatorId, (leaf) => {
    if (group === "writing") {
      const variants = writingVariantsForLeaf(leaf).map((variant) => ({ ...variant, entries: removeFromEntries(variant.entries) }));
      const active = variants.find((variant) => variant.id === (leaf.activeWritingVariantId || "main")) || variants[0];
      const ids = flattenNavigatorBoardIds(active?.entries || []);
      return {
        ...leaf,
        writingVariants: variants,
        writingEntries: active?.entries || [],
        activeWritingVariantId: active?.id || "main",
        writingBoardIds: ids,
        ...(leaf.mainBoardId === boardId ? { mainBoardId: ids[0] } : {}),
      };
    }
    const entries = removeFromEntries(navigatorEntriesForLeaf(leaf, "notes"));
    return { ...leaf, noteEntries: entries, noteBoardIds: flattenNavigatorBoardIds(entries) };
  });
}

function reorderWritingVariant(root: TreeNode, navigatorId: string, sourceId: string, targetId: string, position: "before" | "after"): TreeNode {
  if (sourceId === targetId || sourceId === "main" || targetId === "main") return root;
  return updateNavigator(root, navigatorId, (leaf) => {
    const variants = writingVariantsForLeaf(leaf);
    const sourceIndex = variants.findIndex((variant) => variant.id === sourceId);
    const targetIndex = variants.findIndex((variant) => variant.id === targetId);
    if (sourceIndex <= 0 || targetIndex <= 0) return leaf;
    const next = [...variants];
    const [source] = next.splice(sourceIndex, 1);
    const adjustedTargetIndex = next.findIndex((variant) => variant.id === targetId);
    const insertAt = adjustedTargetIndex + (position === "after" ? 1 : 0);
    next.splice(insertAt, 0, source);
    return { ...leaf, writingVariants: next };
  });
}

function flattenNavigatorBoardIds(entries: NavigatorEntry[]): string[] {
  return entries.flatMap((entry) => entry.type === "board" ? [entry.id] : entry.children);
}

function moveNavigatorBoard(
  root: TreeNode,
  navigatorId: string,
  boardId: string,
  sourceGroup: "writing" | "notes",
  targetGroup: "writing" | "notes",
  targetId: string | null,
  targetParentGroupId: string | null,
  position: "before" | "after",
): TreeNode {
  if (targetId === boardId) return root;
  return updateNavigator(root, navigatorId, (leaf) => {
    let sourceEntries = navigatorEntriesForLeaf(leaf, sourceGroup);
    let found = false;
    sourceEntries = sourceEntries.flatMap<NavigatorEntry>((entry) => {
      if (entry.type === "board") {
        if (entry.id === boardId) { found = true; return []; }
        return [entry];
      }
      const children = entry.children.filter((id) => {
        if (id === boardId) { found = true; return false; }
        return true;
      });
      return children.length ? [{ ...entry, children }] : [];
    });
    if (!found) return leaf;

    let targetEntries = sourceGroup === targetGroup
      ? sourceEntries
      : navigatorEntriesForLeaf(leaf, targetGroup);
    const moved: NavigatorEntry = { type: "board", id: boardId };
    let inserted = false;
    if (targetParentGroupId) {
      targetEntries = targetEntries.map((entry) => {
        if (entry.type !== "group" || entry.id !== targetParentGroupId) return entry;
        const index = targetId ? entry.children.indexOf(targetId) : -1;
        const insertAt = index < 0 ? entry.children.length : index + (position === "after" ? 1 : 0);
        const children = [...entry.children];
        children.splice(insertAt, 0, boardId);
        inserted = true;
        return { ...entry, children, collapsed: false };
      });
    } else {
      let insertAt = targetId ? targetEntries.findIndex((entry) => entry.id === targetId) : -1;
      if (insertAt < 0) insertAt = targetEntries.length;
      else if (position === "after") insertAt += 1;
      targetEntries = [...targetEntries];
      targetEntries.splice(insertAt, 0, moved);
      inserted = true;
    }
    if (!inserted) return leaf;

    const sourceIds = sourceGroup === targetGroup ? flattenNavigatorBoardIds(targetEntries) : flattenNavigatorBoardIds(sourceEntries);
    const targetIds = sourceGroup === targetGroup ? sourceIds : flattenNavigatorBoardIds(targetEntries);
    let nextLeaf = sourceGroup === targetGroup
      ? sourceGroup === "writing"
        ? { ...leaf, writingEntries: targetEntries, writingBoardIds: targetIds }
        : { ...leaf, noteEntries: targetEntries, noteBoardIds: targetIds }
      : {
          ...leaf,
          writingEntries: sourceGroup === "writing" ? sourceEntries : targetEntries,
          noteEntries: sourceGroup === "notes" ? sourceEntries : targetEntries,
          writingBoardIds: sourceGroup === "writing" ? sourceIds : targetIds,
          noteBoardIds: sourceGroup === "notes" ? sourceIds : targetIds,
        };
    if (sourceGroup !== targetGroup) {
      const activeId = leaf.activeWritingVariantId || "main";
      const variants = writingVariantsForLeaf(leaf).map((variant) => {
        let entries: NavigatorEntry[] = variant.entries.flatMap<NavigatorEntry>((entry) => {
          if (entry.type === "board") return entry.id === boardId ? [] : [entry];
          const children = entry.children.filter((id) => id !== boardId);
          return children.length ? [{ ...entry, children }] : [];
        });
        if (targetGroup === "writing") {
          entries = variant.id === activeId
            ? targetEntries
            : [...entries, { type: "board" as const, id: boardId }];
        }
        return { ...variant, entries };
      });
      const active = variants.find((variant) => variant.id === activeId) || variants[0];
      nextLeaf = {
        ...nextLeaf,
        writingVariants: variants,
        activeWritingVariantId: activeId,
        writingEntries: active?.entries || [],
        writingBoardIds: flattenNavigatorBoardIds(active?.entries || []),
      };
    }
    return nextLeaf;
  });
}

function moveNavigatorGroup(
  root: TreeNode,
  navigatorId: string,
  groupId: string,
  sourceGroup: "writing" | "notes",
  targetGroup: "writing" | "notes",
  targetId: string | null,
  position: "before" | "after",
): TreeNode {
  if (sourceGroup !== targetGroup || targetId === groupId) return root;
  return updateNavigator(root, navigatorId, (leaf) => {
    const entries = navigatorEntriesForLeaf(leaf, sourceGroup);
    const moving = entries.find((entry) => entry.type === "group" && entry.id === groupId);
    if (!moving) return leaf;
    const remaining = entries.filter((entry) => !(entry.type === "group" && entry.id === groupId));
    let insertAt = targetId ? remaining.findIndex((entry) => entry.id === targetId) : -1;
    if (insertAt < 0) insertAt = remaining.length;
    else if (position === "after") insertAt += 1;
    const nextEntries = [...remaining];
    nextEntries.splice(insertAt, 0, moving);
    const ids = flattenNavigatorBoardIds(nextEntries);
    return sourceGroup === "writing"
      ? { ...leaf, writingEntries: nextEntries, writingBoardIds: ids }
      : { ...leaf, noteEntries: nextEntries, noteBoardIds: ids };
  });
}

function setTextBoardGroup(root: TreeNode, boardId: string, group: "writing" | "notes"): TreeNode {
  if (root.type === "leaf") {
    return root.kind === "text" && root.textId === boardId ? { ...root, textGroup: group } : root;
  }
  return { ...root, a: setTextBoardGroup(root.a, boardId, group), b: setTextBoardGroup(root.b, boardId, group) };
}

function groupNavigatorBoards(root: TreeNode, navigatorId: string, group: "writing" | "notes", selectedIds: string[], groupId: string, groupName: string): TreeNode {
  if (selectedIds.length < 1) return root;
  return updateNavigator(root, navigatorId, (leaf) => {
    const entries = navigatorEntriesForLeaf(leaf, group);
    const selected = new Set(selectedIds);
    const selectedEntries = entries.filter((entry) => entry.type === "board" && selected.has(entry.id));
    if (selectedEntries.length !== selectedIds.length || selectedEntries.length < 1) return leaf;
    const firstIndex = entries.findIndex((entry) => entry.type === "board" && selected.has(entry.id));
    const groupEntry: NavigatorEntry = {
      type: "group", id: groupId, name: groupName,
      collapsed: false, children: selectedEntries.map((entry) => entry.id),
    };
    const nextEntries: NavigatorEntry[] = [];
    entries.forEach((entry, index) => {
      if (index === firstIndex) nextEntries.push(groupEntry);
      if (entry.type === "board" && selected.has(entry.id)) return;
      nextEntries.push(entry);
    });
    const ids = flattenNavigatorBoardIds(nextEntries);
    return group === "writing"
      ? { ...leaf, writingBoardIds: ids, writingEntries: nextEntries }
      : { ...leaf, noteBoardIds: ids, noteEntries: nextEntries };
  });
}

function ungroupNavigatorGroups(root: TreeNode, navigatorId: string, group: "writing" | "notes", selectedIds: string[]): { tree: TreeNode; expandedIds: string[] } {
  let expandedIds: string[] = [];
  const selected = new Set(selectedIds);
  const tree = updateNavigator(root, navigatorId, (leaf) => {
    const entries = navigatorEntriesForLeaf(leaf, group);
    const nextEntries: NavigatorEntry[] = [];
    entries.forEach((entry) => {
      if (entry.type === "group" && selected.has(entry.id)) {
        expandedIds.push(...entry.children);
        nextEntries.push(...entry.children.map((id) => ({ type: "board" as const, id })));
      } else nextEntries.push(entry);
    });
    const ids = flattenNavigatorBoardIds(nextEntries);
    return group === "writing"
      ? { ...leaf, writingBoardIds: ids, writingEntries: nextEntries }
      : { ...leaf, noteBoardIds: ids, noteEntries: nextEntries };
  });
  return { tree, expandedIds };
}

function toggleNavigatorGroup(root: TreeNode, navigatorId: string, group: "writing" | "notes", groupId: string): TreeNode {
  return updateNavigator(root, navigatorId, (leaf) => {
    const entries = navigatorEntriesForLeaf(leaf, group);
    const nextEntries = entries.map((entry) => entry.type === "group" && entry.id === groupId
      ? { ...entry, collapsed: !entry.collapsed } : entry);
    return group === "writing" ? { ...leaf, writingEntries: nextEntries } : { ...leaf, noteEntries: nextEntries };
  });
}

function renameNavigatorGroup(root: TreeNode, navigatorId: string, group: "writing" | "notes", groupId: string, name: string): TreeNode {
  return updateNavigator(root, navigatorId, (leaf) => {
    const entries = navigatorEntriesForLeaf(leaf, group);
    const nextEntries = entries.map((entry) => entry.type === "group" && entry.id === groupId
      ? { ...entry, name: name || entry.name } : entry);
    return group === "writing" ? { ...leaf, writingEntries: nextEntries } : { ...leaf, noteEntries: nextEntries };
  });
}

function setNavigatorBoardName(root: TreeNode, navigatorId: string, boardId: string, name: string): TreeNode {
  return updateNavigator(root, navigatorId, (leaf) => {
    const boardNames = { ...(leaf.boardNames || {}) };
    if (name) boardNames[boardId] = name;
    else delete boardNames[boardId];
    return { ...leaf, boardNames };
  });
}

function retargetGroupTextBoard(root: TreeNode, group: "writing" | "notes", boardId: string): TreeNode {
  let retargeted = false;
  const walk = (node: TreeNode): TreeNode => {
    if (node.type === "leaf") {
      if (!retargeted && node.kind === "text" && (node.textGroup ?? "writing") === group) {
        retargeted = true;
        return { ...node, textId: boardId };
      }
      return node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

function findLeafOfKind(root: TreeNode, kind: LeafKind): LeafNode | undefined {
  if (root.type === "leaf") return root.kind === kind ? root : undefined;
  return findLeafOfKind(root.a, kind) ?? findLeafOfKind(root.b, kind);
}

function removeManuscriptView(root: TreeNode): TreeNode {
  const manuscript = findLeafOfKind(root, "manuscript");
  if (!manuscript) return root;

  // Preserve the original Navigator/Manuscript sizing when closing the
  // default left-side arrangement.
  if (root.type === "split" && root.a.type === "split"
    && root.a.a.type === "leaf" && root.a.a.kind === "navigator"
    && root.a.b.type === "leaf" && root.a.b.id === manuscript.id) {
    return { ...root, ratio: 0.18, a: root.a.a };
  }
  return removeLeaf(root, manuscript.id);
}

function closeManuscriptBeforeNavigatorMutation(root: TreeNode, leafId: string): TreeNode {
  return findLeaf(root, leafId)?.kind === "navigator"
    ? removeManuscriptView(root)
    : root;
}

function insertManuscriptAfterNavigator(root: TreeNode, navigatorId: string): TreeNode {
  const navigator = findLeaf(root, navigatorId);
  if (!navigator || containsLeafKind(root, "manuscript")) return root;

  // Keep the familiar Navigator sidebar width for the standard arrangement.
  if (root.type === "split" && root.a.type === "leaf" && root.a.id === navigatorId) {
    return {
      ...root,
      ratio: 0.42,
      a: { type: "split", dir: "vertical", ratio: 0.42, a: root.a, b: makeLeaf("manuscript") },
    };
  }

  const manuscript = makeLeaf("manuscript");
  const insert = (node: TreeNode): TreeNode => {
    if (node.type === "leaf") {
      return node.id === navigatorId
        ? { type: "split", dir: "vertical", ratio: 0.42, a: node, b: manuscript }
        : node;
    }
    return { ...node, a: insert(node.a), b: insert(node.b) };
  };
  return insert(root);
}

function toggleManuscriptView(root: TreeNode, navigatorId: string): TreeNode {
  return containsLeafKind(root, "manuscript")
    ? removeManuscriptView(root)
    : insertManuscriptAfterNavigator(root, navigatorId);
}

function updateRatioByPath(root: TreeNode, path: number[], next: number): TreeNode {
  const r = Math.min(0.9999, Math.max(0.0001, next));
  if (path.length === 0) {
    return root.type === "split" ? { ...(root as SplitNode), ratio: r } : root;
  }
  if (root.type !== "split") return root;
  const key = path[0] === 0 ? "a" : "b";
  const child = (root as SplitNode)[key] as TreeNode;
  return { ...root, [key]: updateRatioByPath(child, path.slice(1), r) } as SplitNode;
}

// ---- split ratio helpers (global-anchored) ----
const EPS = 1e-4;
const clamp01 = (x:number) => Math.min(1 - EPS, Math.max(EPS, x));
type Axis = "x" | "y";
const axisOf = (dir:"vertical"|"horizontal"): Axis => (dir === "vertical" ? "x" : "y");

function getNodeAtPath(root: TreeNode, path: number[]): TreeNode {
  let n: TreeNode = root;
  for (const step of path) {
    if (n.type !== "split") break;
    n = step === 0 ? (n as SplitNode).a : (n as SplitNode).b;
  }
  return n;
}

// Compute global [0..1] interval occupied by path along the given axis
function getInterval01(root: TreeNode, path: number[], axis: Axis): [number, number] {
  let s = 0, e = 1;
  let n: TreeNode = root;
  for (const step of path) {
    if (n.type !== "split") break;
    const sn = n as SplitNode;
    const aligned = (axis === "x" && sn.dir === "vertical") || (axis === "y" && sn.dir === "horizontal");
    if (aligned) {
      const len = e - s;
      if (step === 0) e = s + len * sn.ratio;
      else            s = s + len * sn.ratio;
    }
    n = step === 0 ? sn.a : sn.b;
  }
  return [s, e];
}

// Collect descendant split paths aligned to the same axis (excluding the parent)
function collectDescSplitsSameAxis(root: TreeNode, parentPath: number[], axis: Axis): number[][] {
  const out: number[][] = [];
  const start = getNodeAtPath(root, parentPath);
  const walk = (n: TreeNode, p: number[]) => {
    if (n.type !== "split") return;
    const sn = n as SplitNode;
    const aligned = (axis === "x" && sn.dir === "vertical") || (axis === "y" && sn.dir === "horizontal");
    if (aligned) out.push(p);
    walk(sn.a, [...p, 0]);
    walk(sn.b, [...p, 1]);
  };
  walk(start, parentPath);
  return out.filter(pp => pp.length > parentPath.length);
}

function findLeaf(n: TreeNode, id: string): LeafNode | undefined {
  if (n.type === "leaf") return n.id === id ? n : undefined;
  return findLeaf(n.a, id) ?? findLeaf(n.b, id);
}

function swapLeafPositions(root: TreeNode, firstId: string, secondId: string): TreeNode {
  if (firstId === secondId) return root;
  const first = findLeaf(root, firstId);
  const second = findLeaf(root, secondId);
  if (!first || !second) return root;
  const walk = (node: TreeNode): TreeNode => {
    if (node.type === "leaf") {
      if (node.id === firstId) return second;
      if (node.id === secondId) return first;
      return node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

function collectTextLeaves(n: TreeNode, out: LeafNode[] = []): LeafNode[] {
  if (n.type === "leaf") {
    if (n.kind === "text") out.push(n);
    return out;
  }
  collectTextLeaves(n.a, out);
  collectTextLeaves(n.b, out);
  return out;
}

function findNavigatorLeaf(n: TreeNode): LeafNode | undefined {
  if (n.type === "leaf") return n.kind === "navigator" ? n : undefined;
  return findNavigatorLeaf(n.a) ?? findNavigatorLeaf(n.b);
}

function allocateTextBoardId(
  root: TreeNode,
  openText: Record<string, string>,
  archivedText: Record<string, string>,
  nextUid: () => string,
): string {
  const used = new Set<string>([
    ...Object.keys(openText || {}),
    ...Object.keys(archivedText || {}),
  ]);
  const visit = (node: TreeNode) => {
    if (node.type === "split") {
      visit(node.a);
      visit(node.b);
      return;
    }
    if (node.textId) used.add(node.textId);
    for (const id of [...(node.writingBoardIds || []), ...(node.noteBoardIds || [])]) used.add(id);
    for (const id of Object.keys(node.boardNames || {})) used.add(id);
    const collectEntries = (entries?: NavigatorEntry[]) => {
      for (const entry of entries || []) {
        if (entry.type === "board") used.add(entry.id);
        else for (const id of entry.children) used.add(id);
      }
    };
    collectEntries(node.writingEntries);
    collectEntries(node.noteEntries);
    for (const variant of node.writingVariants || []) collectEntries(variant.entries);
  };
  visit(root);

  let id = "";
  do { id = `T${nextUid()}`; } while (used.has(id));
  return id;
}

function containsLeafKind(n: TreeNode, kind: LeafKind): boolean {
  if (n.type === "leaf") return n.kind === kind;
  return containsLeafKind(n.a, kind) || containsLeafKind(n.b, kind);
}

function changeKind(root: TreeNode, leafId: string, next: LeafKind): TreeNode {
  const walk = (n: TreeNode): TreeNode => {
    if (n.type === "leaf") return n.id === leafId ? { ...n, kind: next } : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(root);
}

function splitLeaf(root: TreeNode, leafId: string, dir: "horizontal" | "vertical", newTextId?: string): TreeNode {
  const makeSplit = (leaf: LeafNode): SplitNode => ({
    type: "split", dir, ratio: 0.5, a: leaf,
    b: leaf.kind === "text"
      ? { ...makeLeaf("text", leaf.textGroup ?? "writing"), ...(newTextId ? { textId: newTextId } : {}) }
      : makeLeaf(leaf.kind, leaf.textGroup),
  });
  const walk = (n: TreeNode): TreeNode => {
    if (n.type === "leaf") return n.id === leafId ? makeSplit(n) : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(root);
}

function replaceLeafWithNew(root: TreeNode, leafId: string, kind: LeafKind): TreeNode {
  const walk = (n: TreeNode): TreeNode => {
    if (n.type === "leaf") return n.id === leafId ? { ...makeLeaf(kind), id: n.id } : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(root);
}

function changeTextBoardKind(root: TreeNode, leafId: string, kind: "text"): TreeNode {
  if (root.type === "leaf") {
    if (root.id !== leafId) return root;
    if (root.kind === "text" || root.kind === "scenario") return { ...root, kind };
    const replacement = makeLeaf(kind, "writing");
    return { ...replacement, id: root.id, textId: root.textId };
  }
  return {
    ...root,
    a: changeTextBoardKind(root.a, leafId, kind),
    b: changeTextBoardKind(root.b, leafId, kind),
  };
}

function removeLeaf(root: TreeNode, leafId: string): TreeNode {
  if (root.type === "leaf") return root;
  const lift = (n: SplitNode): TreeNode => {
    if (n.a.type === "leaf" && n.a.id === leafId) return n.b;
    if (n.b.type === "leaf" && n.b.id === leafId) return n.a;
    return {
      ...n,
      a: n.a.type === "split" ? lift(n.a as SplitNode) : n.a,
      b: n.b.type === "split" ? lift(n.b as SplitNode) : n.b,
    };
  };
  return lift(root as SplitNode);
}

function retargetLeafTextId(root: TreeNode, leafId: string, newTextId: string): TreeNode {
  const walk = (n: TreeNode): TreeNode =>
    n.type === "leaf"
      ? (n.id === leafId ? { ...n, textId: newTextId } : n)
      : { ...n, a: walk(n.a), b: walk(n.b) };
  return walk(root);
}

function retargetLeafAsText(
  root: TreeNode,
  leafId: string,
  textId: string,
  textGroup: "writing" | "notes",
): TreeNode {
  const walk = (node: TreeNode): TreeNode => node.type === "leaf"
    ? node.id === leafId ? { ...node, kind: "text", textId, textGroup } : node
    : { ...node, a: walk(node.a), b: walk(node.b) };
  return walk(root);
}

function findLeavesByTextId(n: TreeNode, textId: string, acc: string[] = []): string[] {
  if (n.type === "leaf") {
    if (n.textId === textId) acc.push(n.id);
    return acc;
  }
  findLeavesByTextId(n.a, textId, acc);
  findLeavesByTextId(n.b, textId, acc);
  return acc;
}

function getEditableRoot(el: Element | null): HTMLElement | null {
  return (el?.closest?.('[data-board-id] [contenteditable="true"]') as HTMLElement | null) ?? null;
}

function getGlobalTextOffsets(root: HTMLElement, sel: Selection | null) {
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  // Compute anchor/focus offsets relative to editor root
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let start = 0, end = 0, pos = 0;
  let foundStart = false, foundEnd = false;
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.data.length;

    if (!foundStart && r.startContainer === n) {
      start = pos + r.startOffset;
      foundStart = true;
    }
    if (!foundEnd && r.endContainer === n) {
      end = pos + r.endOffset;
      foundEnd = true;
    }
    pos += len;
  }
  if (!foundStart || !foundEnd) {
    // If boundaries are not inside text nodes (e.g., empty div), fall back to end
    const total = pos;
    return { start: total, end: total };
  }
  return { start, end };
}

function setSelectionByOffsets(root: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let sNode: Text | null = null, eNode: Text | null = null;
  let sOff = 0, eOff = 0;

  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.data.length;

    if (!sNode && start <= pos + len) {
      sNode = n;
      sOff = Math.max(0, start - pos);
    }
    if (!eNode && end <= pos + len) {
      eNode = n;
      eOff = Math.max(0, end - pos);
      break;
    }
    pos += len;
  }

  // Editor may contain no text nodes (empty editor)
  const range = document.createRange();
  if (!sNode) {
    range.setStart(root, 0);
    range.setEnd(root, 0);
  } else if (!eNode) {
    range.setStart(sNode, sOff);
    range.setEnd(sNode, sOff);
  } else {
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
  }

  sel.removeAllRanges();
  sel.addRange(range);
  (root as HTMLElement).focus();
}

export default function MainUI() {
  const [tree, setTree] = useState<TreeNode>(makeInitialTree());
  const [activeNavigatorTextId, setActiveNavigatorTextId] = useState<string | null>(null);
  const [activeTextLeafId, setActiveTextLeafId] = useState<string | null>(null);
  const [selectedNavigatorBoardIds, setSelectedNavigatorBoardIds] = useState<string[]>([]);
  const navigatorSelectionAnchorRef = React.useRef<string | null>(null);

  const TITLEBAR_H = 36;
  const TOPBAR_H = 32;

  const [preset, setPreset] = useState<number>(2); 
  const [presetSeq, setPresetSeq] = useState<number>(0); 

  const [showSidebar, setShowSidebar] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const textRefs = React.useRef<Record<string, TextBoardHandle | null>>({});
  const viewerRefs = useRef<Record<string, ViewerBoardHandle | null>>({});

  const [viewerStates, setViewerStates] = React.useState<Record<string, ViewerState>>({});

  const historyRef = React.useRef<{ stack: HistorySnap[]; idx: number; cap: number }>({
  stack: [],
  idx: -1,
  cap: 50, 
  });

// 3-button confirm state
type Ask3Choice = "save" | "discard" | "cancel";
type Ask3Labels = { save: string; discard: string; cancel: string };
const [ask3State, setAsk3State] = React.useState<{open:boolean; msg:string; labels?: Ask3Labels; resolve?(v:Ask3Choice):void}>({open:false, msg:""});

const ask3 = React.useCallback((msg: string, labels?: Ask3Labels) => {
  return new Promise<Ask3Choice>((resolve) => {
    setAsk3State({ open: true, msg, labels, resolve });
  });
}, []);

const isReplayingRef = React.useRef(false);

const makeSnap = (): HistorySnap => {
  const ed = getEditableRoot(document.activeElement);
  let selection: HistorySnap["selection"] | undefined;
  if (ed) {
    const boardEl = ed.closest('[data-board-id]') as HTMLElement | null;
    const off = getGlobalTextOffsets(ed, window.getSelection?.() || null);
    if (boardEl && off) {
      selection = {
        boardId: boardEl.getAttribute("data-board-id") || "",
        start: off.start,
        end: off.end,
      };
    }
  }

  return {
    tree: treeRef.current,
    texts: { ...(boardHTMLRef.current || {}) },
    images: { ...(imageDocsRef.current || {}) },
    archivedText: { ...(archivedTextRef.current || {}) },
    archivedImage: { ...(archivedImageRef.current || {}) },
    selection,
  };
};

const applySnap = (s: HistorySnap) => {
  isReplayingRef.current = true;
  const activeIsEditor = !!getEditableRoot(document.activeElement);

  requestAnimationFrame(() => {
    isReplayingRef.current = false;

    if (!activeIsEditor) return;

    const sel = s.selection;
    if (!sel || !sel.boardId) return;

    const activeId = getActiveBoardEl()?.getAttribute("data-board-id") || "";
    if (activeId && activeId !== sel.boardId) return; 

    const root = document.querySelector(
      `[data-board-id="${sel.boardId}"] [contenteditable="true"]`
    ) as HTMLElement | null;
    if (!root) return;
    setSelectionByOffsets(root, sel.start, sel.end);
    if (activeId) root.focus();
  });
  
  const sameTree         = JSON.stringify(s.tree)          === JSON.stringify(treeRef.current);
  const sameImages       = JSON.stringify(s.images)        === JSON.stringify(imageDocsRef.current || {});
  const sameArchText     = JSON.stringify(s.archivedText)  === JSON.stringify(archivedTextRef.current || {});
  const sameArchImage    = JSON.stringify(s.archivedImage) === JSON.stringify(archivedImageRef.current || {});

  if (sameTree && sameImages && sameArchText && sameArchImage) {
    // 1) Update in-memory store
    boardHTMLRef.current = { ...(s.texts || {}) };

    // 2) Inject into currently mounted boards only
    Object.entries(s.texts || {}).forEach(([id, html]) => {
      const root = document.querySelector(
        `[data-board-id="${id}"] [contenteditable="true"]`
      ) as HTMLElement | null;
      if (root) root.innerHTML = html || "";
    });

    // 3) Restore selection on next frame
    requestAnimationFrame(() => {
      isReplayingRef.current = false;
      if (!activeIsEditor) return;
      const sel = s.selection;
      if (!sel || !sel.boardId) return;

      const activeId = getActiveBoardEl()?.getAttribute("data-board-id") || "";
      if (activeId && activeId !== sel.boardId) return;

      const root = document.querySelector(
        `[data-board-id="${sel.boardId}"] [contenteditable="true"]`
      ) as HTMLElement | null;
      if (!root) return;
      setSelectionByOffsets(root, sel.start, sel.end);
      if (activeId) root.focus();
    });

    io.markDirty();
    return;
  }

  // From here on: tree/images changed — take the general path
  setTree(s.tree);
  boardHTMLRef.current = { ...(s.texts || {}) };
  setImageDocs(s.images || {});
  setArchivedText(s.archivedText || {});
  setArchivedImage(s.archivedImage || {});
  setSessionKey(k => k + 1);

  requestAnimationFrame(() => {
      isReplayingRef.current = false;
      const sel = s.selection;
      if (!sel || !sel.boardId) return;
      const root = document.querySelector(
        `[data-board-id="${sel.boardId}"] [contenteditable="true"]`
      ) as HTMLElement | null;
      if (!root) return;
      setSelectionByOffsets(root, sel.start, sel.end);
      root.focus();
    });

    io.markDirty();
  };

  const pushHistory = (reason = "") => {
    if (isReplayingRef.current) return;

    const snap = makeSnap();
    const H = historyRef.current;

    if (H.idx < H.stack.length - 1) H.stack = H.stack.slice(0, H.idx + 1);

    const prev = H.stack[H.idx];
    const same =
      prev &&
      JSON.stringify(prev.tree) === JSON.stringify(snap.tree) &&
      Object.keys(snap.texts).every((k) => prev.texts[k] === snap.texts[k]) &&
      JSON.stringify(prev.images) === JSON.stringify(snap.images) &&
      JSON.stringify(prev.archivedText) === JSON.stringify(snap.archivedText) &&
      JSON.stringify(prev.archivedImage) === JSON.stringify(snap.archivedImage);
    if (same) return;

    const activeEl = getEditableRoot(document.activeElement);
    let selection: HistorySnap["selection"] = undefined;
    if (activeEl) {
      const boardEl = activeEl.closest('[data-board-id]') as HTMLElement | null;
      const sel = getGlobalTextOffsets(activeEl, window.getSelection?.() || null);
      if (boardEl && sel) {
        selection = { boardId: boardEl.getAttribute('data-board-id') || '', start: sel.start, end: sel.end };
      }
    }

    const withSel: HistorySnap = { ...cloneSnap(snap), selection };
      H.stack.push(withSel);
      if (H.stack.length > H.cap) H.stack.shift();
      H.idx = H.stack.length - 1;
    };
    const undo = () => {
      const H = historyRef.current;
      if (H.idx <= 0) return;
      H.idx -= 1;
      applySnap(cloneSnap(H.stack[H.idx]));
    };
    const redo = () => {
      const H = historyRef.current;
      if (H.idx >= H.stack.length - 1) return;
      H.idx += 1;
      applySnap(cloneSnap(H.stack[H.idx]));
    };
  
  // Seed the first history snapshot
  React.useEffect(() => {
    requestAnimationFrame(() => pushHistory("seed"));
  }, []);

  // hoisted split handler
  function handleRequestSplit(leafId: string, dir: "horizontal" | "vertical", duplicate = false) {
    flushOpenEditorsToStore();
    const source = findLeaf(treeRef.current, leafId);
    const newTextId = source?.kind === "text"
      ? allocateTextBoardId(treeRef.current, boardHTMLRef.current, archivedTextRef.current, uid)
      : undefined;
    const group = source?.textGroup ?? "writing";
    if (newTextId) boardHTMLRef.current[newTextId] = duplicate ? (boardHTMLRef.current[source!.textId] ?? "") : "";
    const sourceName = source && findNavigatorLeaf(treeRef.current)?.boardNames?.[source.textId]
      || (source ? firstLineFromHTML(boardHTMLRef.current[source.textId] ?? "", 36) : "")
      || "Untitled TextBoard";
    setTree(prev => {
      let next = splitLeaf(prev, leafId, dir, newTextId);
      if (newTextId) {
        const navigator = findNavigatorLeaf(next);
        if (navigator) {
          next = addNavigatorBoard(next, navigator.id, group, newTextId);
          if (duplicate) next = setNavigatorBoardName(next, navigator.id, newTextId, `${sourceName} — Copy`);
        }
      }
      return next;
    });
    io.markDirty();
    if (newTextId) io.notify(`${group === "notes" ? "Note" : "Writing"} board ${duplicate ? "duplicated" : "created"}.`, "info", 1600);
    requestAnimationFrame(() => pushHistory("split"));
  }

  function handleDuplicatePane(sourceLeafId: string, targetLeafId: string) {
    flushOpenEditorsToStore();
    const currentTree = treeRef.current;
    const source = findLeaf(currentTree, sourceLeafId);
    const target = findLeaf(currentTree, targetLeafId);
    if (!source || source.kind !== "text" || !target || (target.kind !== "text" && target.kind !== "scenario")) return;
    const group = source.textGroup ?? "writing";
    const newTextId = allocateTextBoardId(currentTree, boardHTMLRef.current, archivedTextRef.current, uid);
    boardHTMLRef.current[newTextId] = boardHTMLRef.current[source.textId] ?? "";
    const sourceName = findNavigatorLeaf(currentTree)?.boardNames?.[source.textId]
      || firstLineFromHTML(boardHTMLRef.current[source.textId] ?? "", 36)
      || "Untitled TextBoard";
    setTree((previous) => {
      const navigator = findNavigatorLeaf(previous);
      let next = navigator ? addNavigatorBoard(previous, navigator.id, group, newTextId) : previous;
      if (navigator) next = setNavigatorBoardName(next, navigator.id, newTextId, `${sourceName} — Copy`);
      return retargetLeafAsText(next, targetLeafId, newTextId, group);
    });
    setActiveNavigatorTextId(newTextId);
    setSelectedNavigatorBoardIds([]);
    navigatorSelectionAnchorRef.current = null;
    setSessionKey((key) => key + 1);
    setDuplicateTargetLeafId(null);
    io.markDirty();
    io.notify(`${group === "notes" ? "Note" : "Writing"} board duplicated.`, "info", 1600);
    requestAnimationFrame(() => pushHistory("duplicate-board-to-pane"));
  }

  function handleDuplicateNavigatorBoard(boardId: string, group: "writing" | "notes") {
    flushOpenEditorsToStore();
    const currentTree = treeRef.current;
    const navigator = findNavigatorLeaf(currentTree);
    if (!navigator) return;
    const sourceHTML = boardHTMLRef.current[boardId] ?? "";
    const newTextId = allocateTextBoardId(currentTree, boardHTMLRef.current, archivedTextRef.current, uid);
    boardHTMLRef.current[newTextId] = sourceHTML;
    const sourceName = navigator.boardNames?.[boardId] || firstLineFromHTML(sourceHTML, 36) || "Untitled TextBoard";
    setTree((previous) => {
      const currentNavigator = findNavigatorLeaf(previous);
      if (!currentNavigator) return previous;
      let next = addNavigatorBoard(previous, currentNavigator.id, group, newTextId);
      return setNavigatorBoardName(next, currentNavigator.id, newTextId, `${sourceName} — Copy`);
    });
    setActiveNavigatorTextId(newTextId);
    setSelectedNavigatorBoardIds([newTextId]);
    navigatorSelectionAnchorRef.current = newTextId;
    io.markDirty();
    setSessionKey((key) => key + 1);
    io.notify(`${group === "notes" ? "Note" : "Writing"} board duplicated.`, "info", 1600);
    requestAnimationFrame(() => pushHistory("duplicate-navigator-board"));
  }

  function handleSwapPanes(sourceLeafId: string, targetLeafId: string) {
    if (!sourceLeafId || !targetLeafId || sourceLeafId === targetLeafId) return;
    const currentTree = treeRef.current;
    const source = findLeaf(currentTree, sourceLeafId);
    const target = findLeaf(currentTree, targetLeafId);
    if (!source || !target || source.kind === "manuscript" || target.kind === "manuscript") return;
    flushOpenEditorsToStore();
    const navigatorMoves = source.kind === "navigator" || target.kind === "navigator";
    const manuscriptWasOpen = containsLeafKind(currentTree, "manuscript");
    let nextTree = navigatorMoves && manuscriptWasOpen
      ? removeManuscriptView(currentTree)
      : currentTree;
    nextTree = swapLeafPositions(nextTree, sourceLeafId, targetLeafId);
    treeRef.current = nextTree;
    setTree(nextTree);
    setSwapTargetLeafId(null);
    io.markDirty();
    pushHistory("swap-panes");
  }

  // 현재 열려 있는 SWON 파일 경로를 전역에서 읽어오는 헬퍼
  function readCurrentFileGlobal(): string | null {
    try {
      const w: any = window;

      // 우리가 기존에 쓰던 전역 (Sidebar 도 이걸 본다)
      const p1 = w.__SW_CURRENT_FILE__;
      if (typeof p1 === "string" && p1) return p1 as string;

      // 혹시 swon IO 를 전역에 노출해둔 경우 대비
      const io = w.__SWON_IO__;
      if (io) {
        if (typeof io.getCurrentFilePath === "function") {
          const p2 = io.getCurrentFilePath();
          if (typeof p2 === "string" && p2) return p2;
        }
        if (typeof io.currentFilePath === "string" && io.currentFilePath) {
          return io.currentFilePath as string;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  function flushOpenEditorsToStore() {
    const nodes = document.querySelectorAll<HTMLElement>('[data-board-id] [contenteditable="true"]');
    nodes.forEach(root => {
      const boardEl = root.closest('[data-board-id]') as HTMLElement | null;
      if (!boardEl) return;
      const id = boardEl.getAttribute('data-board-id') || '';
      if (!id) return;
      boardHTMLRef.current[id] = normalizeHTMLForDirty(root.innerHTML || '');
    });
  }

  function firstLineFromHTML(html: string, max = 80): string {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    const raw = (div.textContent || "").replace(/\u00A0/g, " ").trim();
    const line = raw.split(/\r?\n/)[0] || "";
    return line.length > max ? line.slice(0, max - 1) + "…" : line;
  }

  const [activePreset, setActivePreset] = useState<number>(2);

  const [prefs, setPrefs] = useState<PrefsType>(() => loadPrefsFromStorage(DEFAULT_PREFS));
  const [workingFolder, setWorkingFolder] = useState("");

  React.useEffect(() => {
    const theme = prefs.theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    document.body?.setAttribute("data-theme", theme);
    document.getElementById("root")?.setAttribute("data-theme", theme);
    applyAccentTokens(prefs.accentColor);
    applyInputLocaleDom((prefs as any).inputLocale);
  }, [prefs.theme, prefs.accentColor, (prefs as any).inputLocale]);

  // docs
  const [imageDocs, setImageDocs] = useState<Record<string, SwonImage>>({});
  const imageRefs = useRef<Record<string, ImageBoardHandle | null>>({});
  const [imagePaths, setImagePaths] = useState<Record<string, string>>({});
  const blobToPathRef = useRef<Record<string, string>>({});

  // Missing-on-disk indicator state
  const [imageMissing, setImageMissing] = useState<Record<string, boolean>>({});
  const imagePathsRef = useRef(imagePaths);
  React.useEffect(() => { imagePathsRef.current = imagePaths; }, [imagePaths]);

  const printExportActiveRef = useRef(false);

  async function onExportPrint(provider?: () => string) {
    if (printExportActiveRef.current) return;
    printExportActiveRef.current = true;
    const hideWait = showPrintWait(io, "Preparing print preview…");
    let completed = false;
    let statusTimer: number | undefined;
    let safetyTimer: number | undefined;

    const finishTracking = () => {
      if (completed) return;
      completed = true;
      if (statusTimer !== undefined) window.clearTimeout(statusTimer);
      if (safetyTimer !== undefined) window.clearTimeout(safetyTimer);
      try { hideWait(); } catch {}
      printExportActiveRef.current = false;
      window.removeEventListener("message", onMsg);
    };

    const onMsg = (ev: MessageEvent) => {
      const d: any = ev?.data;
      if (!d) return;

      if (d.who === "splitwriter" && d.type === "SW_PRINT_OPENING") {
        try { hideWait(); } catch {}
      }
      if (d.who === "splitwriter" && d.type === "SW_PRINT_FAILED") {
        io.notify("Could not open the PDF print dialog. Please try again.", "error", 2600);
      }
      if (d.who === "splitwriter" && d.type === "SW_PRINT_CLOSED") {
        finishTracking();
      }
      if (d.__sw_print_done__) {
        finishTracking();
      }
    };
    window.addEventListener("message", onMsg);

    // Hide the preparation status after 10 seconds, but keep listening while
    // the native print dialog is open so a slow user choice can still finish.
    statusTimer = window.setTimeout(() => {
      try { hideWait(); } catch {}
    }, 10000);
    // Recover the export lock if WebView fails to report a print completion.
    safetyTimer = window.setTimeout(() => {
      io.notify("PDF export timed out. Please try again.", "warn", 3000);
      finishTracking();
    }, 120000);

    const getHTML = () => {
      if (provider) return provider();
      const root = document.querySelector(
        '[data-sw-editor-root], [data-sw-editor]'
      ) as HTMLElement | null;
      return root ? root.innerHTML : "";
    };

    const tf = (prefs as any)?.typeface;
    const bodyPx = Number(tf?.body?.size ?? 16);

    try {
      printHTML(getHTML, {
        page: "A4",
        marginMm: 18,
        baseFont: { family: String(tf?.body?.name || "system-ui"), sizePx: bodyPx },
        title: "Splitwriter",
        usePaged: true,
        onlyPageNumber: true,
      });
    } catch (error) {
      console.error("[Splitwriter] could not prepare PDF export:", error);
      const detail = error instanceof Error ? error.message : "Unknown error";
      io.notify(`PDF export failed: ${detail}`, "error", 3600);
      finishTracking();
    }
  }

  // Safe verification (never mutates image src)
  const revalidateTimer = useRef<number | null>(null);
  const revalidateMissingSafe = React.useCallback(async () => {
    const isTauri = Boolean((window as any).__TAURI_IPC__);
    if (!isTauri) return;

    const { exists } = await import("@tauri-apps/api/fs");
    const paths = imagePathsRef.current;

    const next: Record<string, boolean> = {};
    for (const [id, abs] of Object.entries(paths)) {
      if (!abs) { next[id] = false; continue; }
      let ok = false;
      try { ok = await exists(abs); } catch { ok = false; }
      next[id] = !ok;
    }

    setImageMissing(prev => {
      let changed = false;
      const out = { ...prev };
      for (const [id, miss] of Object.entries(next)) {
        if (prev[id] !== miss) { out[id] = miss; changed = true; }
      }
      return changed ? out : prev;
    });
  }, []);

  // Debounced check whenever imagePaths change (add/replace, undo/redo)
  React.useEffect(() => {
    if (revalidateTimer.current) window.clearTimeout(revalidateTimer.current);
    revalidateTimer.current = window.setTimeout(() => {
      revalidateMissingSafe();
    }, 200) as unknown as number;
    return () => {
      if (revalidateTimer.current) window.clearTimeout(revalidateTimer.current);
    };
  }, [imagePaths, revalidateMissingSafe]);

  // Optional: re-check when window regains focus
  React.useEffect(() => {
    const onFocus = () => { revalidateMissingSafe(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [revalidateMissingSafe]);

  // ImageBoard-local undo/redo history
  const imageHistRef = React.useRef<
    Record<string, { stack: (string | null)[]; idx: number; cap: number }>
  >({});

  // Track last-focused ImageBoard (for global image undo/redo)
  const lastImageFocusRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const onFocusIn = (e: Event) => {
     const el = e.target as HTMLElement | null;
      const box = el?.closest?.('[data-role="imageboard"][data-image-id]') as HTMLElement | null;
      if (box) lastImageFocusRef.current = box.getAttribute('data-image-id');
    };
    window.addEventListener('focusin', onFocusIn, true);
    return () => window.removeEventListener('focusin', onFocusIn, true);
  }, []);

  const seedImageHistory = React.useCallback((imageId: string, initial: string | null) => {
    if (!imageHistRef.current[imageId]) {
      imageHistRef.current[imageId] = { stack: [initial ?? null], idx: 0, cap: 50 };
    }
  }, []);

  // Sync typeface → CSS variables
  React.useEffect(() => {
    const tfTable =
      (prefs as any)?.typefaces ??
      (prefs as any)?.typeface ?? null;
    applyTypeTokens(tfTable || undefined);
  }, [ (prefs as any)?.typefaces, (prefs as any)?.typeface ]);

  React.useEffect(() => {
    applyParagraphIndentTokens(prefs);
  }, [prefs.paragraphIndent, prefs.typeface]);

  const pushImageHistory = React.useCallback((imageId: string, next: string | null) => {
    const H = imageHistRef.current[imageId] ?? { stack: [], idx: -1, cap: 50 };
    const base = H.stack.slice(0, H.idx + 1);
    base.push(next ?? null);
    while (base.length > H.cap) base.shift();
    imageHistRef.current[imageId] = { stack: base, idx: base.length - 1, cap: H.cap };
  }, []);

  const imageUndo = React.useCallback((imageId: string): string | null | undefined => {
    const H = imageHistRef.current[imageId];
    if (!H) return undefined; 
    if (H.idx <= 0) return undefined; 
    H.idx -= 1;
    return H.stack[H.idx];
  }, []);

  const imageRedo = React.useCallback((imageId: string): string | null | undefined => {
    const H = imageHistRef.current[imageId];
    if (!H) return undefined;
    if (H.idx >= H.stack.length - 1) return undefined;
    H.idx += 1;
    return H.stack[H.idx];
  }, []);

  React.useEffect(() => {
    const docs = imageDocsRef.current || {};
    for (const [id, doc] of Object.entries(docs)) {
      seedImageHistory(id, (doc as any)?.src ?? null);
    }
  }, [seedImageHistory, imageDocs]);

  const focusImageBoard = React.useCallback((imageId: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-role="imageboard"][data-image-id="${imageId}"]`
      ) as HTMLElement | null;
      if (el) {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        (el as any).focus?.({ preventScroll: true });
      }
    });
  }, []);

  // Persist workingFolder under a dedicated key (updated via Preferences)
  React.useEffect(() => {
    if (workingFolder) {
      try { localStorage.setItem(PREFS_WF_KEY, workingFolder); } catch {}
    }
  }, [workingFolder]);

  // archive
  const [archivedText, setArchivedText] = useState<Record<string, string>>({});
  const [archivedImage, setArchivedImage] = useState<Record<string, SwonImage>>({});
 
  const boardHTMLRef = useRef<Record<string, string>>({});
  
  const getInitialHTML = (id: string) => boardHTMLRef.current[id] ?? "";

  const [sessionKey, setSessionKey] = React.useState(0);

  const treeRef = React.useRef(tree);
  React.useEffect(() => { treeRef.current = tree; }, [tree]);
  const windowStateRef = React.useRef<SwonWindowState | undefined>(undefined);
  const suppressWindowDirtyUntilRef = React.useRef(0);

  const archivedTextRef = React.useRef(archivedText);
  React.useEffect(() => { archivedTextRef.current = archivedText; }, [archivedText]);

  const imageDocsRef = React.useRef(imageDocs);
  React.useEffect(() => { imageDocsRef.current = imageDocs; }, [imageDocs]);

  const archivedImageRef = React.useRef(archivedImage);
  React.useEffect(() => { archivedImageRef.current = archivedImage; }, [archivedImage]);

  const prefsRef = React.useRef(prefs);
  React.useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  const ask = React.useCallback(async (msg: string) => {
    const isTauri = Boolean((window as any).__TAURI_IPC__);
    if (isTauri) {
      const { confirm } = await import("@tauri-apps/api/dialog");
      return await confirm(msg, { title: "Splitwriter", type: "warning" });
    }
    return window.confirm(msg);
  }, []);

  const savingReasonRef = React.useRef<null | "auto">(null);

  const notifyImpl = React.useCallback(
    (text: string, level: "info" | "warn" | "error" = "info", ttl = 0) => {
      const auto = savingReasonRef.current === "auto";

      // 파일 관련 메시지( *.swon 이 들어 있는 경우)에 한해서만
      // 타이틀바 파일명 갱신
      if (!auto && text && text.includes(".swon")) {
        try {
          updateTitleFromStatus(text);
        } catch {
          // 타이틀 갱신 실패해도 status 바 자체는 그대로 가도록 무시
        }
      }

      const msg = auto ? "✓ Auto-saved" : text;
      window.dispatchEvent(
        new CustomEvent("sw:status", { detail: { text: msg, level, ttl } })
      );
    },
    []
  );

  const io = React.useMemo(() => setupSwonIO({
    getTree: () => treeRef.current,
    setTree,

    getOpenText: () => boardHTMLRef.current,
    setOpenText: (m) => { boardHTMLRef.current = m || {}; },

    getArchivedText: () => archivedTextRef.current,
    setArchivedText,

    getImages: () => {
      const docs  = imageDocsRef.current || {};
      const paths = imagePathsRef.current || {};
      const out: Record<string, SwonImage> = {};
      for (const id of Object.keys(docs)) {
        const im = docs[id] as SwonImage;
        out[id] = { ...im, file: (paths as any)[id] ?? im.file ?? null };
      }
      for (const id of Object.keys(paths)) {
        if (!out[id]) out[id] = { src: null, file: (paths as any)[id] };
      }
      return out;
    },

    setImages: (m) => {
      setImageDocs(m);
      setImagePaths(prev => {
        const next = { ...prev };
        for (const [id, im] of Object.entries(m || {})) {
          if (im && typeof im.file === "string") next[id] = im.file!;
        }
        return next;
      });
    },

    getPrefs: () => prefsRef.current,

    setPrefs: (patch: PrefsType | ((p: PrefsType)=>PrefsType)) => {
      setPrefs(prev => {
        const next = (typeof patch === "function") ? (patch as any)(prev) : patch;
        const wfLocal = (() => {
          try { return localStorage.getItem(PREFS_WF_KEY) || ""; } catch { return ""; }
        })();

        const merged: PrefsType = {
          ...next,
          workingFolder: wfLocal || (prev as any).workingFolder || (next as any).workingFolder || "",
        };

        try {
          const dehydrated = { ...merged } as any;
          localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(dehydrated));
          if (merged.workingFolder) localStorage.setItem(PREFS_WF_KEY, merged.workingFolder);
        } catch {}

        return merged;
      });
    },

    getWindowState: () => windowStateRef.current,
    setWindowState: (state) => {
      if (!(window as any).__TAURI_IPC__) return;
      suppressWindowDirtyUntilRef.current = Date.now() + 1800;
      windowStateRef.current = state;
      void (async () => {
        try {
          const { appWindow, LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
          if (await appWindow.isMaximized()) await appWindow.unmaximize();
          const screen = window.screen;
          const left = Number((screen as any).availLeft ?? 0);
          const top = Number((screen as any).availTop ?? 0);
          const availableWidth = Math.max(1, screen.availWidth);
          const availableHeight = Math.max(1, screen.availHeight);
          const minWidth = Math.min(900, availableWidth);
          const minHeight = Math.min(400, availableHeight);
          const width = Math.min(availableWidth, Math.max(minWidth, state.width));
          const height = Math.min(availableHeight, Math.max(minHeight, state.height));
          const rightLimit = left + Math.max(0, availableWidth - width);
          const bottomLimit = top + Math.max(0, availableHeight - height);
          const x = Math.round(Math.min(Math.max(state.x, left), rightLimit));
          const y = Math.round(Math.min(Math.max(state.y, top), bottomLimit));
          await appWindow.setSize(new LogicalSize(width, height));
          await appWindow.setPosition(new LogicalPosition(x, y));
          if (state.maximized) await appWindow.maximize();
        } catch (error) {
          console.warn("[swon] failed to restore window bounds", error);
        }
      })();
    },

    getEchoBg: () => (window as any).__SW_ECHO_BG__ ?? null,
    makeFreshTree: () => makeInitialTree(),
    bumpSession: () => setSessionKey(x => x + 1),
    notify: notifyImpl,
  }), [notifyImpl]);

  React.useEffect(() => {
    if (!(window as any).__TAURI_IPC__) return;
    let disposed = false;
    let timer: number | undefined;
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;

    const capture = async (markDirty: boolean) => {
      try {
        const { appWindow } = await import("@tauri-apps/api/window");
        const maximized = await appWindow.isMaximized();
        const previous = windowStateRef.current;
        const next: SwonWindowState = maximized && previous
          ? { ...previous, maximized: true }
          : {
              x: Math.round(window.screenX),
              y: Math.round(window.screenY),
              width: Math.round(window.outerWidth || window.innerWidth),
              height: Math.round(window.outerHeight || window.innerHeight),
              maximized,
            };
        if (disposed) return;
        const changed = JSON.stringify(previous) !== JSON.stringify(next);
        windowStateRef.current = next;
        if (markDirty && changed && Date.now() >= suppressWindowDirtyUntilRef.current) io.markDirty();
      } catch {
        // Window geometry is optional outside supported Tauri desktop builds.
      }
    };
    const scheduleCapture = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void capture(true); }, 250);
    };

    void (async () => {
      try {
        const { appWindow } = await import("@tauri-apps/api/window");
        await capture(false);
        unlistenResize = await appWindow.onResized(scheduleCapture);
        unlistenMove = await appWindow.onMoved(scheduleCapture);
      } catch {
        // Web preview has no native window bounds API.
      }
    })();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, [io]);

  // (dev note removed)
  React.useEffect(() => {
    initAppActions({
      io,
      ask,
      ask3,  
      hasBoundFileRef, // will be toggled when Save As / Open bind a file handle
    });
  }, [io, ask]);

  // Welcome — per launch, once.
  React.useEffect(() => {
    io.notify("Welcome to Splitwriter.", "info", 1200);
  }, [io]);

  const hasBoundFileRef = React.useRef(false);
  const autosaveWarnedRef = React.useRef(false);
  const autosaveOverrideForFileRef = React.useRef<boolean | null>(null);
  const autosaveOverrideBeforeOpenRef = React.useRef<boolean | null>(null);
  const [autosaveSessionOverride, setAutosaveSessionOverride] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const onOpening = () => {
      autosaveOverrideBeforeOpenRef.current = autosaveOverrideForFileRef.current;
      autosaveOverrideForFileRef.current = false;
      setAutosaveSessionOverride(false);
    };
    const onOpened = () => {
      autosaveOverrideForFileRef.current = false;
      setAutosaveSessionOverride(false);
      window.dispatchEvent(new CustomEvent("sw:status", {
        detail: {
          text: "Autosave is paused for this file.",
          actionLabel: "Enable autosave",
          actionEvent: "sw:autosave:enable-for-file",
          persistent: true,
        },
      }));
    };
    const onCancelled = () => {
      autosaveOverrideForFileRef.current = autosaveOverrideBeforeOpenRef.current;
      setAutosaveSessionOverride(autosaveOverrideBeforeOpenRef.current);
      autosaveOverrideBeforeOpenRef.current = null;
    };
    const onCleared = () => {
      autosaveOverrideForFileRef.current = null;
      setAutosaveSessionOverride(null);
      autosaveOverrideBeforeOpenRef.current = null;
    };
    const onEnable = () => {
      autosaveOverrideForFileRef.current = true;
      setAutosaveSessionOverride(true);
      window.dispatchEvent(new Event("sw:status:clear-persistent"));
      window.dispatchEvent(new CustomEvent("sw:status", {
        detail: { text: "Autosave enabled for this file.", level: "info" },
      }));
    };
    const onToggleForFile = (event: Event) => {
      const enabled = !!(event as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
      autosaveOverrideForFileRef.current = enabled;
      setAutosaveSessionOverride(enabled);
      if (enabled) {
        window.dispatchEvent(new Event("sw:status:clear-persistent"));
      } else {
        window.dispatchEvent(new CustomEvent("sw:status", {
          detail: {
            text: "Autosave is paused for this file.",
            actionLabel: "Enable autosave",
            actionEvent: "sw:autosave:enable-for-file",
            persistent: true,
          },
        }));
      }
    };

    window.addEventListener("sw:project:opening", onOpening);
    window.addEventListener("sw:project:opened", onOpened);
    window.addEventListener("sw:project:open-cancelled", onCancelled);
    window.addEventListener("sw:file:cleared", onCleared);
    window.addEventListener("sw:autosave:enable-for-file", onEnable);
    window.addEventListener("sw:autosave:toggle-for-file", onToggleForFile);
    return () => {
      window.removeEventListener("sw:project:opening", onOpening);
      window.removeEventListener("sw:project:opened", onOpened);
      window.removeEventListener("sw:project:open-cancelled", onCancelled);
      window.removeEventListener("sw:file:cleared", onCleared);
      window.removeEventListener("sw:autosave:enable-for-file", onEnable);
      window.removeEventListener("sw:autosave:toggle-for-file", onToggleForFile);
    };
  }, []);

  // ★ 파일명 표시 리셋
  function clearCurrentFileLabel() {
    hasBoundFileRef.current = false;
    noteCurrentFile(null);
  }

  // ★ 파일명/바인딩 상태만 관리, Working Folder는 절대 건드리지 않음
  async function setCurrentFileAndNotify(path: string, fromEvent = false) {
    const p = path || "";

    // autosave guard용: 실제 디스크 파일이 있는지만 체크
    hasBoundFileRef.current = !!p;

    // 파일 라벨(상태바/타이틀바)만 갱신
    if (!fromEvent) {
      noteCurrentFile(p || null);
    }
  }

  const autosaveWelcomeGuardRef = React.useRef(true);

  // Autosave Guard
  ( window as any ).__SW_APPLY_PREFS__ = (next: PrefsType) => setPrefs(next);

  async function getDefaultPresetPath() {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    const base = await appLocalDataDir();
    const dir  = await join(base, "Splitwriter");
    const file = await join(dir, "default-preset.json");
    return { dir, file };
  }

  // --- Local prefs (always-updating) -------------------------------
  async function getLocalPrefsPath() {
    if (!(window as any).__TAURI_IPC__) return null;
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    const base = await appLocalDataDir();
    const dir  = await join(base, "Splitwriter");
    const file = await join(dir, "local-prefs.json");
    return { dir, file };
  }

  async function readLocalPrefsFile(): Promise<PrefsType | null> {
    if (!(window as any).__TAURI_IPC__) return null;
    const { exists, readTextFile, writeTextFile } = await import("@tauri-apps/api/fs");
    const p = await getLocalPrefsPath();
    if (!p) return null;
    try {
      if (!(await exists(p.file))) return null;
      const raw = await readTextFile(p.file);
      const obj = JSON.parse(raw);
      const normalized = whitelistPrefsMerge(DEFAULT_PREFS, obj);
      // Upgrade older preference files with newly added options and discard stale keys.
      if (!prefsMatchCurrentSchema(obj, normalized)) {
        await writeTextFile(p.file, JSON.stringify(normalized, null, 2));
      }
      return normalized;
    } catch {
      return null;
    }
  }

  async function writeLocalPrefsFile(p: PrefsType) {
    if (!(window as any).__TAURI_IPC__) return;
    const { exists, createDir, writeTextFile } = await import("@tauri-apps/api/fs");
    const pth = await getLocalPrefsPath();
    if (!pth) return;
    if (!(await exists(pth.dir))) await createDir(pth.dir, { recursive: true });
    const safe = { ...p } as any;
    await writeTextFile(pth.file, JSON.stringify(safe, null, 2));
  }

  async function ensureDefaultPresetFile(): Promise<PrefsType | null> {
    if (!(window as any).__TAURI_IPC__) return null;
    const { exists, createDir, writeTextFile, readTextFile } = await import("@tauri-apps/api/fs");
    try {
      const { dir, file } = await getDefaultPresetPath();
      if (!(await exists(dir))) await createDir(dir, { recursive: true });
      if (!(await exists(file))) {
        await writeTextFile(file, JSON.stringify(DEFAULT_PREFS, null, 2));
        return DEFAULT_PREFS;
      }
      const raw = await readTextFile(file);
      const parsed = JSON.parse(raw);
      const normalized = whitelistPrefsMerge(DEFAULT_PREFS, parsed);
      // Keep the startup/default file in sync with the current preference schema.
      if (!prefsMatchCurrentSchema(parsed, normalized)) {
        await writeTextFile(file, JSON.stringify(normalized, null, 2));
      }
      return normalized;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function writeDefaultPresetFile(p: PrefsType) {
    if (!(window as any).__TAURI_IPC__) return;
    const { writeTextFile } = await import("@tauri-apps/api/fs");
    const { file } = await getDefaultPresetPath();
    try { await writeTextFile(file, JSON.stringify(p, null, 2)); } catch (e) { console.error(e); }
  }

  async function pickJSONText(): Promise<string | null> {
    const isTauri = !!(window as any).__TAURI_IPC__;
    if (isTauri) {
      const [{ open }, { readTextFile }] = await Promise.all([
        import("@tauri-apps/api/dialog"),
        import("@tauri-apps/api/fs"),
      ]);
      const p = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof p === "string") return await readTextFile(p);
      return null;
    }
    return await new Promise<string | null>((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json,.json";
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return resolve(null);
        resolve(await f.text());
      };
      inp.click();
    });
  }

  async function duplicateImageToProject(imageId: string) {
    try {
      const baseDir = await getProjectDirNow();
      if (!baseDir) { io.notify("Save this project as a .swon first to duplicate images.", "warn", 1800); return; }

      const abs = imagePathsRef.current?.[imageId] || null;
      const srcUrl = imageDocsRef.current?.[imageId]?.src || null;
      if (!abs && !srcUrl) { io.notify("No image to duplicate.", "warn", 1600); return; }

      if (!(window as any).__TAURI_IPC__) {
        io.notify("Available only in desktop build.", "warn", 1600);
        return;
      }

      const [{ readBinaryFile, writeBinaryFile, createDir, exists, removeFile }, { join, basename }] =
        await Promise.all([import("@tauri-apps/api/fs"), import("@tauri-apps/api/path")]);

      const outDir = await join(baseDir, "_Images");
      if (!(await exists(outDir))) await createDir(outDir, { recursive: true });

      let bytes: Uint8Array;
      let mimeType = "";
      if (abs) {
        bytes = await readBinaryFile(abs);
      } else {
        const res = await fetch(srcUrl as string);
        if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
        mimeType = res.headers.get("content-type") || "";
        bytes = new Uint8Array(await res.arrayBuffer());
      }

      const extensionForMime: Record<string, string> = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
        "image/gif": ".gif", "image/bmp": ".bmp", "image/svg+xml": ".svg",
      };
      const sourceHasNoFilePath = !abs && /^(?:data|blob):/i.test(srcUrl || "");
      const pathName = (abs || (sourceHasNoFilePath ? "" : srcUrl) || "")
        .split(/[?#]/, 1)[0]
        .replace(/\\/g, "/")
        .split("/")
        .pop() || "";
      let originalName = abs ? await basename(abs) : pathName;
      try { originalName = decodeURIComponent(originalName); } catch { /* keep original name */ }
      const match = originalName.match(/^(.*?)(\.[^.]+)?$/);
      const extFromName = match?.[2] || "";
      const extension = extFromName || extensionForMime[mimeType.split(";", 1)[0].trim().toLowerCase()] || ".bin";
      const stem = (match?.[1] || "image").trim() || "image";
      const safeStem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "image";

      // Never overwrite an existing image: other boards may already reference it.
      let imgName = `${safeStem}${extension}`;
      let outPath = await join(outDir, imgName);
      let suffix = 2;
      while (await exists(outPath)) {
        imgName = `${safeStem} (${suffix++})${extension}`;
        outPath = await join(outDir, imgName);
      }

      await writeBinaryFile(outPath, bytes);
      const applied = await applyImageFromAbsPath(imageId, outPath);
      if (!applied) {
        try { await removeFile(outPath); } catch { /* keep the copied file if cleanup is unavailable */ }
        io.notify("The image was copied, but this board could not be updated.", "error", 2200);
        return;
      }
      io.notify(`Image copied to the '_Images' folder.\n${imgName}`, "info", 2200);
    } catch (error) {
      console.error("Duplicate image failed:", error);
      io.notify("Could not copy the image to the project folder.", "error", 2200);
    }
  }

  async function getProjectDirNow(): Promise<string | null> {
    // 브라우저 프리뷰 모드에서는 항상 실패 처리
    if (!(window as any).__TAURI_IPC__) return null;

    const p = readCurrentFileGlobal();
    if (!p) return null;

    try {
      const { dirname } = await import("@tauri-apps/api/path");
      // 현재 열려 있는 .swon 파일이 있는 폴더가 "프로젝트 폴더"
      return await dirname(p);
    } catch {
      return null;
    }
  }

  // TXT: use provided board; otherwise, the currently focused board
  async function onExportTxt(provider?: () => string) {
    const getPlain = () => {
      if (provider) return provider();
      const root = document.querySelector(
        '[data-board-id] [data-role="editor-root"], [data-board-id] [contenteditable="true"]'
      ) as HTMLElement | null;
      return root ? htmlToPlainText(root, prefsRef.current.paragraphIndent) : "";
    };

    const { exportPlainText } = await import("./runtime/exporters/textExport");
    const name = await exportPlainText(getPlain);
    if (name) io.notify(`${name} exported.`, "info", 1500);
    else io.notify("Export canceled.", "warn", 1200);
  }

  async function importDefaultPresetFromFile() {
    try {
      const text = await pickJSONText();
      if (!text) return;
      let raw: any;
      try { raw = JSON.parse(text); } catch { io.notify("Invalid preset file.", "error", 1800); return; }
      const next = whitelistPrefsMerge(DEFAULT_PREFS, raw);
      applyPrefsAndPersist(next, (m)=>io.notify(m, "info", 1600));
      await writeDefaultPresetFile(next);
    } catch (e: any) {
      console.error(e);
      io.notify("Preset import failed.", "error", 2000);
    }
  }

  async function exportCurrentPresetToFile() {
    try {
      const data = JSON.stringify(prefsRef.current, null, 2);
      const isTauri = !!(window as any).__TAURI_IPC__;
      if (isTauri) {
        const [{ save }, { writeTextFile }] = await Promise.all([
          import("@tauri-apps/api/dialog"),
          import("@tauri-apps/api/fs"),
        ]);
        const dest = await save({ defaultPath: "splitwriter-preset.json", filters: [{ name: "JSON", extensions: ["json"] }] });
        if (typeof dest === "string") { await writeTextFile(dest, data); io.notify("Preset exported.", "info", 1500); }
        return;
      }
      const blob = new Blob([data], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "splitwriter-preset.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      io.notify("Preset exported.", "info", 1500);
    } catch (e: any) {
      console.error(e);
      io.notify("Preset export failed.", "error", 2000);
    }
  }

  function resetDefaultPresetToBuiltIn() {
    applyPrefsAndPersist(DEFAULT_PREFS, (m)=>io.notify(m, "info", 1600));
    void writeDefaultPresetFile(DEFAULT_PREFS); 
    void writeLocalPrefsFile(DEFAULT_PREFS);  
  }

  async function applyDefaultPresetNow() {
    const disk = await ensureDefaultPresetFile();
    if (!disk) { io.notify("No default preset file found.", "warn", 1600); return; }

    const keepWF = prefsRef.current?.workingFolder;
    const next = { ...whitelistPrefsMerge(DEFAULT_PREFS, disk), workingFolder: keepWF ?? disk.workingFolder };

    applyPrefsAndPersist(next, (m)=>io.notify(m, "info", 1600));

    if (next.workingFolder) setWorkingFolder(next.workingFolder);
  }

  // TXT: use provided board; otherwise, the currently focused board
  function showPrintWait(io: any, text = "Preparing print preview…") {
    // Prefer Splitwriter's status panel if available
    if (io?.status?.show) {
      const key = io.status.show({ text, type: "progress" }); 
      return () => io.status.hide?.(key);
    }
    // Otherwise use notify with a long TTL as pseudo-persistent
    if (io?.notify) {
      const ret = io.notify(text, "info", 12000);
      return () => io.dismiss?.(ret);
    }
    // No-op fallback
    return () => {};
  }

  const emitEditState = React.useCallback(() => {
    const fromOpen = Object.entries(boardHTMLRef.current || {}).map(([id, html]) => ({ id, html, source: "open" as const }));
    const fromArchived = Object.entries(archivedTextRef.current || {}).map(([id, html]) => ({ id, html, source: "saved" as const }));
    const map = new Map<string, { id: string; html: string; source: "open" | "saved" }>();
    for (const it of [...fromArchived, ...fromOpen]) map.set(it.id, it);
    window.dispatchEvent(new CustomEvent("sw:edit:state", { detail: { texts: Array.from(map.values()) } }));
  }, []);

  const handleDeleteBoards = React.useCallback(
    async (textIds: string[]) => {
      if (!textIds?.length) return;

      const ok =
        (await (async () => {
          try {
            if ((window as any).__TAURI_IPC__) {
              const { confirm } = await import("@tauri-apps/api/dialog");
              return await confirm(`Delete ${textIds.length} text board(s)? This cannot be undone.`, {
                title: "Splitwriter",
                type: "warning",
              });
            }
          } catch {}
          return window.confirm(`Delete ${textIds.length} text board(s)? This cannot be undone.`);
        })());

      if (!ok) return;

      // Actual delete commit
      for (const tid of textIds) {
        const leaves = findLeavesByTextId(treeRef.current, tid);
        if (leaves.length) {
          const newId = allocateTextBoardId(treeRef.current, boardHTMLRef.current, archivedTextRef.current, uid);
          boardHTMLRef.current[newId] = "";
          setTree(t => {
            let r = t;
            for (const l of leaves) r = retargetLeafTextId(r, l, newId);
            return r;
          });
        }
        delete boardHTMLRef.current[tid];
        delete (archivedTextRef.current as any)[tid];
      }

      io.markDirty();
      setSessionKey(k => k + 1);
      emitEditState();
      pushHistory("deleteBoards");
      io.notify(textIds.length === 1 ? "Text board deleted." : `${textIds.length} text boards deleted.`, "info", 1600);
    },
    [emitEditState, io, setTree]
  );

  const handleNavigatorDeleteBoards = React.useCallback((boardIds: string[], group: "writing" | "notes") => {
    flushOpenEditorsToStore();
    const currentTree = treeRef.current;
    const navigator = findNavigatorLeaf(currentTree);
    if (!navigator) return;
    const existingIds = new Set(flattenNavigatorBoardIds(navigatorEntriesForLeaf(navigator, group)));
    const ids = Array.from(new Set(boardIds)).filter((id) => existingIds.has(id));
    if (!ids.length) return;
    const remainingIds = group === "writing"
      ? Array.from(new Set(writingVariantsForLeaf(navigator)
          .flatMap((variant) => flattenNavigatorBoardIds(variant.entries))))
          .filter((id) => !ids.includes(id))
      : flattenNavigatorBoardIds(navigatorEntriesForLeaf(navigator, group)).filter((id) => !ids.includes(id));
    const remainingActiveWritingIds = flattenNavigatorBoardIds(navigatorEntriesForLeaf(navigator, "writing"))
      .filter((id) => !ids.includes(id));
    if (group === "writing" && remainingIds.length === 0) return;

    const openLeafIds = Array.from(new Set(ids.flatMap((id) => findLeavesByTextId(currentTree, id))));
    let closedTree = currentTree;
    for (const leafId of openLeafIds) closedTree = removeLeaf(closedTree, leafId);
    if (openLeafIds.length) {
      treeRef.current = closedTree;
      setTree(closedTree);
    }
    requestAnimationFrame(() => {
      const latestTree = treeRef.current;
      const latestNavigator = findNavigatorLeaf(latestTree);
      if (!latestNavigator) return;
      const deletedTree = ids.reduce((nextTree, id) => removeNavigatorBoard(nextTree, latestNavigator.id, group, id), latestTree);
      treeRef.current = deletedTree;
      setTree(deletedTree);
      for (const id of ids) {
        delete boardHTMLRef.current[id];
        delete archivedTextRef.current[id];
      }
      setArchivedText((previous) => {
        const next = { ...previous };
        for (const id of ids) delete next[id];
        return next;
      });
      if (activeNavigatorTextId && ids.includes(activeNavigatorTextId)) setActiveNavigatorTextId(remainingActiveWritingIds[0] || remainingIds[0] || null);
      setSelectedNavigatorBoardIds((selected) => selected.filter((id) => !ids.includes(id)));
      navigatorSelectionAnchorRef.current = null;
      io.markDirty();
      setSessionKey((key) => key + 1);
      emitEditState();
      requestAnimationFrame(() => pushHistory("delete-navigator-board"));
      io.notify(ids.length === 1
        ? group === "writing" ? "Writing board deleted." : "Note board deleted."
        : `${ids.length} ${group === "writing" ? "Writing" : "Note"} boards deleted.`, "info", 1600);
    });
  }, [activeNavigatorTextId, emitEditState, io, setArchivedText]);

  const handleNavigatorDeleteBoard = React.useCallback((boardId: string, group: "writing" | "notes") => {
    handleNavigatorDeleteBoards([boardId], group);
  }, [handleNavigatorDeleteBoards]);

  React.useEffect(() => {
    if (!(window as any).__TAURI_IPC__) return;
    const onFocus = async () => {
      try {
        const { exists, writeTextFile } = await import("@tauri-apps/api/fs");
        const lp = await getLocalPrefsPath();
        if (lp && !(await exists(lp.file)))
          await writeTextFile(lp.file, JSON.stringify(prefsRef.current, null, 2));

        const dp = await getDefaultPresetPath();
        if (dp && !(await exists(dp.file)))
          await writeTextFile(dp.file, JSON.stringify(DEFAULT_PREFS, null, 2));
      } catch {}
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  React.useEffect(() => {
    (async () => {
      // 0) Initial: from localStorage (also in web/dev envs)
      let loaded = loadPrefsFromStorage(DEFAULT_PREFS);

      if ((window as any).__TAURI_IPC__) {
        // 1) Priority: local-prefs.json (user-updating preset)
        const local = await readLocalPrefsFile();
        if (local) {
          loaded = whitelistPrefsMerge(loaded, local);
        } else {
          // 2) Fallback: default-preset.json (create if missing) → factory defaults
          const factory = await ensureDefaultPresetFile(); 
          loaded = whitelistPrefsMerge(loaded, factory || DEFAULT_PREFS);
          // 3) Guard: seed local-prefs.json now if missing/corrupt to stabilize next boot
          await writeLocalPrefsFile(loaded);
        }
      }

      setPrefs(loaded);
      setWorkingFolder(loaded.workingFolder || "");
      try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(loaded)); } catch {}
    })();
  }, []);

  React.useEffect(() => {
    const onImport = () => importDefaultPresetFromFile();
    const onExport = () => exportCurrentPresetToFile();
    const onReset  = () => resetDefaultPresetToBuiltIn();
    const onApply  = () => applyDefaultPresetNow(); 
    window.addEventListener("sw:prefs:import-defaults", onImport as any);
    window.addEventListener("sw:prefs:export-defaults", onExport as any);
    window.addEventListener("sw:prefs:reset-defaults",  onReset  as any);
    window.addEventListener("sw:prefs:apply-defaults",  onApply  as any); 
    return () => {
      window.removeEventListener("sw:prefs:import-defaults", onImport as any);
      window.removeEventListener("sw:prefs:export-defaults", onExport as any);
      window.removeEventListener("sw:prefs:reset-defaults",  onReset  as any);
      window.removeEventListener("sw:prefs:apply-defaults",  onApply  as any);
    };
  }, []);

  React.useEffect(() => {
    const onGet = () => emitEditState();
    window.addEventListener("sw:edit:get", onGet as any, { capture: true });
    return () => window.removeEventListener("sw:edit:get", onGet as any, { capture: true });
  }, [emitEditState]);

  React.useEffect(() => {
    const onOpened = async (e: any) => {
      const p = e?.detail?.path as string | null | undefined;
      if (!p) return;
      await setCurrentFileAndNotify(p, true);
    };
    window.addEventListener("sw:file:opened", onOpened as any);
    return () => window.removeEventListener("sw:file:opened", onOpened as any);
  }, []);

  React.useEffect(() => {
    setImagePaths((prev) => {
      let changed = false;
      const next = { ...prev };

      const docs = imageDocsRef?.current ?? imageDocs; 
      for (const [id, doc] of Object.entries(docs)) {
        const s = doc?.src || "";
        if (!s) continue;

        if (s.startsWith("blob:")) {
          const dp = blobToPathRef.current[s];
          if (dp && next[id] !== dp) { next[id] = dp; changed = true; }
        } else {
        }
      }
      return changed ? next : prev;
    });
  }, [imageDocs]);

  React.useEffect(() => {
    (async () => {
      if (!(window as any).__TAURI_IPC__) return;

      const { readBinaryFile } = await import("@tauri-apps/api/fs");
      const docs = imageDocsRef.current || {};
      const toConvert: Array<[string, string]> = [];
      const looksLikePath = (s: string) =>
        /^[A-Za-z]:\\/.test(s) || /^\\\\/.test(s) || /^\//.test(s);

      for (const [id, doc] of Object.entries(docs)) {
        const s = (doc as any)?.src;
        if (typeof s !== "string" || !s) continue;
        if (s.startsWith("blob:")) continue;
        if (!looksLikePath(s)) continue;
        toConvert.push([id, s]);
      }
      if (!toConvert.length) return;

      const updates: Array<[string, string, string]> = [];
      for (const [id, pth] of toConvert) {
        try {
          const bin = await readBinaryFile(pth);
          const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
          const url = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
          blobToPathRef.current[url] = pth;
          updates.push([id, url, pth]);
        } catch (e) {
          console.warn("image load failed:", pth, e);
        }
      }
      if (!updates.length) return;

      setImageDocs((m) => {
        const out = { ...m };
        for (const [id, url] of updates) {
          const prev = out[id];
          out[id] = { src: url, view: prev?.view };
        }
        return out;
      });
      setImagePaths((p) => {
        const out = { ...p };
        for (const [id, _url, pth] of updates) out[id] = pth;
        return out;
      });
    })();
  }, [imageDocs, io]);

  React.useEffect(() => {
    return () => {
      const docs = imageDocsRef?.current ?? {};
      for (const v of Object.values(docs)) {
        const s = v?.src;
        if (s && s.startsWith("blob:")) {
          try { URL.revokeObjectURL(s); } catch {}
        }
      }
    };
  }, []);

  React.useEffect(() => {

    const onKey = async (e: KeyboardEvent) => {
      const kRaw  = e.key || "";
      const k     = kRaw.toLowerCase();
      const ctrl  = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt   = e.altKey;

      // ────────────────────────────────
      // 1) Tauri / WebView 시스템 단축키 차단
      //    - Ctrl+R, F5 : 페이지 리로드
      //    - Ctrl+J      : 다운로드 창 등
      //    - Ctrl+Shift+I / C / J / R
      // ────────────────────────────────
      if (
        (ctrl && (k === "r" || k === "j")) ||  // Ctrl+R, Ctrl+J
        k === "f5" ||                          // F5
        (!DEVTOOLS_SHORTCUTS_ENABLED && (
          k === "f12" ||
          (ctrl && shift && (k === "i" || k === "c" || k === "j" || k === "r"))
        ))
      ) {
        e.preventDefault();
        e.stopPropagation();
        (e as any).stopImmediatePropagation?.();
        return;
      }

      // ───────── File ops ─────────
      if (ctrl && k === "s" && !shift && !alt) {
        e.preventDefault();
        await save({ createBackup: true });
        return;
      }

      if (ctrl && k === "s" && shift && !alt) {
        e.preventDefault();
        const p = await saveAsAndBind();
        if (p) await setCurrentFileAndNotify(p);
        return;
      }

      if (ctrl && k === "o" && !shift && !alt) {
        e.preventDefault();
        await openWithGuard();
        return;
      }

      if (ctrl && k === "n" && !shift && !alt) {
        e.preventDefault();
        await newWithGuard();
        clearCurrentFileLabel();
        return;
      }

      const inEditor = (e.target as HTMLElement | null)
        ?.closest?.('[data-board-id] [contenteditable="true"]');

      // 텍스트 보드 안에서의 Ctrl+Z / Y 는 브라우저 기본(에디터용) 유지
      if (inEditor && ctrl && (k === "z" || k === "y")) return;

      // 이미지 보드용 Undo/Redo (Ctrl+Z / Y)
      if (ctrl && (k === "z" || k === "y" || (k === "z" && shift))) {
        const imageId = lastImageFocusRef.current;
        if (imageId) {
          e.preventDefault();
          const next =
            k === "z" && !shift ? imageUndo(imageId) : imageRedo(imageId);
          if (next !== undefined) {
            const mappedPath = blobToPathRef.current[next as string] || null;
            setImageDocs((m) => {
              const prev = m[imageId] ?? { src: null as string | null, view: undefined };
              return { ...m, [imageId]: { src: next, view: prev.view } };
            });
            if (mappedPath) {
              setImagePaths((p) => ({ ...p, [imageId]: mappedPath }));
              void revalidateMissingSafe();
            }
            io.markDirty();
            focusImageBoard(imageId);
          }
          return;
        }
      }

      // 글로벌 Undo/Redo (텍스트 에디터 밖에서만)
      if (ctrl && k === "z") {
        if (inEditor) return;
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && k === "y") {
        if (inEditor) return;
        e.preventDefault();
        redo();
        return;
      }

      // 사이드바 토글
      if (ctrl && k === "\\") {
        e.preventDefault();
        setShowSidebar((v) => !v);
        return;
      }
    };

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [io, ask]);

  React.useEffect(() => {
    let timer: number | null = null;
    let firstTick = true;

    const schedule = (sec: number) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(loop, Math.max(5, sec) * 1000) as unknown as number;
    };

    const loop = async () => {
      const p = prefsRef.current;
      const sec = Number(p?.autosaveIntervalSec ?? 60);

      const autosaveEnabled = autosaveOverrideForFileRef.current ?? !!p?.autosave;
      if (autosaveEnabled) {
        if (hasBoundFileRef.current) {
          try {
            if (io.isDirty()) {
              // ★ 중요: 파일 저장은 항상 appActions.save() 경유
              savingReasonRef.current = "auto";
              await save({ autoSave: true });
              // save() 안에서 io.notify(...)가 호출될 때
              // savingReasonRef.current === "auto" 라서
              // notifyImpl이 "✓ Auto-saved" 메시지로 바꿔줄 거야.
            }
          } catch (e) {
            console.error(e);
          } finally {
            savingReasonRef.current = null;
          }
        } else {
          const suppress = autosaveWelcomeGuardRef.current || !io.isDirty();
          autosaveWelcomeGuardRef.current = false; // 첫 틱 지나면 해제

          if (!suppress && !autosaveWarnedRef.current) {
            io.notify("Autosave Failed — save once to start.", "warn", 1800);
            autosaveWarnedRef.current = true;
          }
        }
      }
      firstTick = false;
      schedule(Math.max(5, sec));
    };

    // Start: run once now, then reschedule
    void loop();

    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [io, save]);

  // Mark dirty on text changes
  const handleBoardChange = (id: string, html: string) => {
    const prevRaw = boardHTMLRef.current[id];
    if (prevRaw === undefined) {
      boardHTMLRef.current[id] = html;
      window.dispatchEvent(new CustomEvent("sw:text-content-change", { detail: { id } }));
      return;
    }
    if (prevRaw === html) return;

    boardHTMLRef.current[id] = html;
    window.dispatchEvent(new CustomEvent("sw:text-content-change", { detail: { id } }));

    // Normal typing changes ordinary HTML directly. Avoid reparsing the whole
    // document twice unless a transient caret/selection marker may be present.
    if (!TRANSIENT_DIRTY_MARKUP.test(prevRaw) && !TRANSIENT_DIRTY_MARKUP.test(html)) {
      io.markDirty();
      return;
    }

    const prevNorm = normalizeHTMLForDirty(prevRaw || "");
    const nextNorm = normalizeHTMLForDirty(html || "");
    if (prevNorm !== nextNorm) io.markDirty();
  };

  // Context menu
  type MenuPane =
    | "root"
    | "text:changeType"
    | "text:export"
    | "image:changeType";

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    leafId?: string;
    source?: "handle" | "content";
    pane: MenuPane;
  }>({
    open: false,
    x: 0,
    y: 0,
    pane: "root",
  });

  const openMenuFor = (
    leafId: string,
    pt: { x: number; y: number },
    source: "handle" | "content" = "content"
  ) => {
    window.__CTX_TARGET__ = document.elementFromPoint(pt.x, pt.y) as Element | null;
    setMenu({ open: true, x: pt.x, y: pt.y, leafId, source, pane: "root" });
  };

  const closeMenu = () =>
  setMenu((m) => {
    window.__CTX_TARGET__ = null;
    return { ...m, open: false, leafId: undefined, pane: "root" };
  });

  const deferCloseRef = React.useRef(false);
  const keepOpenOnce = (fn: () => void) => () => {
    deferCloseRef.current = true;
    requestAnimationFrame(() => {
      fn();
    });
  };

  const gotoPane = (pane: MenuPane) => setMenu((m) => ({ ...m, pane }));

  // Image picker
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pickTargetRef = useRef<string | null>(null);
  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files[0]) { e.currentTarget.value = ""; return; }
    const imageId = pickTargetRef.current;
    if (!imageId) { e.currentTarget.value = ""; return; }

    const file = files[0];
    const url = URL.createObjectURL(file);

    // Image change uses its own per-board history; no global push
    const prev = imageDocsRef.current[imageId]?.src ?? null;
    seedImageHistory(imageId, prev);
    pushImageHistory(imageId, url);

    setImageDocs(m => {
      const prevDoc = m[imageId];
      return { ...m, [imageId]: { src: url, view: prevDoc?.view } };
    });
    io.markDirty();
    focusImageBoard(imageId);
  };
  // Image selection (Tauri): open dialog → read bytes → create Blob URL
  const triggerChangeImage = async (imageId: string) => {
    pickTargetRef.current = imageId;
    const isTauri = Boolean((window as any).__TAURI_IPC__);

    if (isTauri) {
      try {
        const [{ open }, { readBinaryFile }] = await Promise.all([
          import("@tauri-apps/api/dialog"),
          import("@tauri-apps/api/fs"),
        ]);

        const picked = await open({
          multiple: false,
          filters: [{ name: "Images", extensions: ["png","jpg","jpeg","webp","gif","bmp"] }],
        });

        if (typeof picked === "string") {
          const prevPath = imagePathsRef.current?.[imageId] || null;
          const bytes = await readBinaryFile(picked);       
          const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes as any);
          const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
          const blob = new Blob([buf], { type: "application/octet-stream" });
          const url  = URL.createObjectURL(blob);

          // Keep previous blob URL alive for undo

          const prev = imageDocsRef.current[imageId]?.src ?? null;
          seedImageHistory(imageId, prev);
          pushImageHistory(imageId, url);

          setImageDocs((m) => {
            const prevDoc = m[imageId];
            return { ...m, [imageId]: { src: url, view: prevDoc?.view } };
          });

          // Store absolute path for display
          setImagePaths((p) => ({ ...p, [imageId]: picked }));
          // Keep blob↔path map for undo/redo path restoration
          blobToPathRef.current[url] = picked;

          if (prevPath !== picked) io.markDirty();

          focusImageBoard(imageId);
          return;
        }
        return; 
      } catch (err) {
        console.error(err);
      }
    }

    requestAnimationFrame(() => fileInputRef.current?.click());
  };

  const applyImageFromAbsPath = React.useCallback(async (imageId: string, absPath: string): Promise<boolean> => {
    try {
      const prevPath = imagePathsRef.current?.[imageId] || null;

      let url: string;
      if ((window as any).__TAURI_IPC__) {
        const { readBinaryFile } = await import("@tauri-apps/api/fs");
        const bytes = await readBinaryFile(absPath);
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as any);
        const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        url = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
      } else {
        const res = await fetch(absPath);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
      }

      const prevSrc = imageDocsRef.current[imageId]?.src ?? null;
      seedImageHistory(imageId, prevSrc);
      pushImageHistory(imageId, url);

      setImageDocs(m => {
        const prevDoc = m[imageId] ?? { src: null as string | null, view: undefined };
        return { ...m, [imageId]: { src: url, view: prevDoc.view } };
      });

      setImagePaths(p => ({ ...p, [imageId]: absPath }));
      blobToPathRef.current[url] = absPath;

      if (prevPath !== absPath) io.markDirty(); 

      focusImageBoard(imageId);
      return true;
    } catch (e) {
      console.error(e);
      io.notify?.("Failed to load image.", "error", 1800);
      return false;
    }
  }, []);

  const handleUseImageEvent = React.useCallback((ev: any) => {
    const abs = ev?.detail?.path as string | undefined;
    let imageId = ev?.detail?.imageId as (string | undefined);
    if (!abs) return;

    imageId = imageId || lastImageFocusRef.current || findFirstImageLeafId(treeRef.current) || undefined;

    if (!imageId) {
      io.notify?.("No Image board focused.", "warn", 1500);
      return;
    }
    void applyImageFromAbsPath(imageId, abs);
  }, [applyImageFromAbsPath, io]);

  React.useEffect(() => {
    const onUse = (e: any) => handleUseImageEvent(e);
    window.addEventListener("sw:image:use", onUse as any);
    return () => window.removeEventListener("sw:image:use", onUse as any);
  }, [handleUseImageEvent]);

  // Split ratio (global-anchored; parent moves don't drag children)
  function applyParentAndRebase(r:number, path:number[], dir:"vertical"|"horizontal") {
    const axis = axisOf(dir);
    const oldTree = treeRef.current;

    const node = getNodeAtPath(oldTree, path) as SplitNode;
    const [s, e] = getInterval01(oldTree, path, axis);
    const g0 = s + node.ratio * (e - s);          // Current parent separator position (global)

    // Collect descendant separators on the same axis (global positions)
    const desc = collectDescSplitsSameAxis(oldTree, path, axis);
    const gs   = desc.map(p => {
      const n = getNodeAtPath(oldTree, p) as SplitNode;
      const [ss, ee] = getInterval01(oldTree, p, axis);
      return ss + n.ratio * (ee - ss);
    });

    // Minimum gap converted from screen px to global [0..1]
    const MIN_GAP_PX = 48; // Minimum handle gap (px)
    const appRoot = document.querySelector('[data-app-root]') as HTMLElement | null;
    const totalPx = appRoot ? (axis === "x" ? appRoot.clientWidth : appRoot.clientHeight) : 1024;
    const gap01   = Math.max(0, MIN_GAP_PX / Math.max(1, totalPx));

    // Treat nearest left/right child separators as hard boundaries
    const leftNeighbor  = gs.filter(g => g < g0).reduce((a,b)=>Math.max(a,b), s);
    const rightNeighbor = gs.filter(g => g > g0).reduce((a,b)=>Math.min(a,b), e);

    const minLimit = Math.max(s + gap01, leftNeighbor + gap01);
    const maxLimit = Math.min(e - gap01, rightNeighbor - gap01);

    // Clamp candidate within [minLimit, maxLimit] to prevent crossing
    const gCand   = s + clamp01(r) * (e - s);
    const gClamp  = Math.min(maxLimit - EPS, Math.max(minLimit + EPS, gCand));
    const parentNext = clamp01((gClamp - s) / (e - s));

    if (Math.abs(parentNext - node.ratio) < 1e-5) return;

    // Update parent ratio
    let t1 = updateRatioByPath(oldTree, path, parentNext);

    // Preserve child global positions (prevent drift)
    for (const p of desc) {
      const [ss, ee] = getInterval01(t1, p, axis);
      const g = (():number => {
        const n = getNodeAtPath(oldTree, p) as SplitNode;
        const [s0, e0] = getInterval01(oldTree, p, axis);
        return s0 + n.ratio * (e0 - s0);
      })();
      const len = Math.max(EPS, ee - ss);
      const r2  = clamp01((g - ss) / len);
      t1 = updateRatioByPath(t1, p, r2);
    }

    setTree(t1);
    io.markDirty();
  }

  const onChangeRatio = (
    nextRatio: number,
    path: number[],
    dir: "vertical" | "horizontal"
  ) => {
    applyParentAndRebase(nextRatio, path, dir);
  };

  const baseTF =
    (prefs as any)?.typeface?.body ?? {
      name: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      size: 16,
    };

  React.useEffect(() => {
    const onInput = (e: Event) => {
      if (isReplayingRef.current) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-board-id] [contenteditable="true"]')) return;
      io.markDirty();
    };

    const onCompositionEnd = (e: Event) => {
      if (isReplayingRef.current) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-board-id] [contenteditable="true"]')) return;
      io.markDirty();
    };

    const onPasteCut = (e: Event) => {
      if (isReplayingRef.current) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-board-id] [contenteditable="true"]')) return;
      io.markDirty();
    };

    window.addEventListener('input', onInput, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('paste', onPasteCut, true);
    window.addEventListener('cut', onPasteCut, true);
    return () => {
      window.removeEventListener('input', onInput, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      window.removeEventListener('paste', onPasteCut, true);
      window.removeEventListener('cut', onPasteCut, true);
    };
  }, [io]);

  React.useEffect(() => {
    const c = (prefs as any)?.accentColor;
    if (c) document.documentElement.style.setProperty("--accent", c);
  }, [prefs]);

  React.useEffect(() => {
    const endAll = () => {
      try { window.dispatchEvent(new MouseEvent("mouseup")); } catch {}
      try { window.dispatchEvent(new PointerEvent("pointerup")); } catch {}
    };
    window.addEventListener("resize", endAll);
    window.addEventListener("blur", endAll);
    return () => {
      window.removeEventListener("resize", endAll);
      window.removeEventListener("blur", endAll);
    };
  }, []);


  function normalizeHTMLForDirty(html: string): string {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;

    // Remove temporary/selection markers
    const rmNodes = div.querySelectorAll(
      '[data-sel], [data-caret], [data-role="sel-keeper"], [data-sw-sel], [data-sw-caret], span[data-zw="1"]'
    );
    rmNodes.forEach(n => n.remove());

    // Remove temporary attributes
    div.querySelectorAll<HTMLElement>("*").forEach(el => {
      ["data-sel","data-caret","data-sw-sel","data-sw-caret","data-zw"].forEach(a => el.removeAttribute(a));
    });

    // Strip control characters (ZWSP/ZWNJ/ZWJ/BOM)
    const walk = (node: Node) => {
      node.childNodes.forEach(ch => {
        if (ch.nodeType === Node.TEXT_NODE) {
          (ch as Text).data = (ch as Text).data.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
        } else {
          walk(ch);
        }
      });
    };
    walk(div);

    return div.innerHTML;
  }

  function findFirstImageLeafId(n: TreeNode): string | null {
    if (n.type === "leaf") return n.kind === "image" ? n.imageId : null;
    return findFirstImageLeafId(n.a) ?? findFirstImageLeafId(n.b);
  }

  // Curly preference normalizer (MainUI only)
  function normalizeCurlyPref(p: any) {
    if (!p) return false;
    if (p === true) return { enabled: true, left: "「", right: "」" };

    if (typeof p === "string") {
      const s = p.trim();
      if (s.length === 2) return [s[0], s[1]] as [string, string];
      const m = s.split(/[,\s]/).filter(Boolean);
      if (m.length === 2) return [m[0], m[1]] as [string, string];
      return false;
    }

    if (Array.isArray(p)) {
      return [p[0] || "“", p[1] || "”"] as [string, string];
    }

    if (typeof p === "object") {
      const enabled = p.enabled !== false;
      if (!enabled) return false;
      return { enabled: true, left: p.left || "“", right: p.right || "”" };
    }

    return false;
  }

  function bracketToCurly(b: any) {
    if (!b || b.enable === false) return false;
    const map: Record<string, [string, string]> = {
      doubleCorner: ["『","』"],
      doubleAngle:  ["≪","≫"],
      singleCorner: ["｢","｣"],
      singleAngle:  ["<",">"],
    };
    const pair = map[b.style === "none" ? "doubleCorner" : b.style];
    if (!pair) return false;     
    return { enabled: true, left: pair[0], right: pair[1] };
  }

  /* ---------- Renderers ---------- */
  const openNavigatorBoard = (
    boardId: string,
    group: "writing" | "notes",
    droppedLeafId: string,
    droppedLeafKind: LeafKind,
    setAsAnchor = false,
  ) => {
    const currentTree = treeRef.current;
    const activeLeaf = activeTextLeafId ? findLeaf(currentTree, activeTextLeafId) : undefined;
    const targetLeafId = droppedLeafKind === "text"
      ? droppedLeafId
      : droppedLeafKind === "image"
        ? droppedLeafId
        : activeLeaf?.kind === "text"
          ? activeLeaf.id
          : collectTextLeaves(currentTree)[0]?.id;
    if (!targetLeafId) return;
    const targetLeaf = findLeaf(currentTree, targetLeafId);
    if (!targetLeaf || (targetLeaf.kind !== "text" && targetLeaf.kind !== "image")) return;
    if (targetLeaf.textId === boardId) {
      if (setAsAnchor) {
        const navigator = findNavigatorLeaf(currentTree);
        if (!navigator) return;
        setTree(updateNavigator(currentTree, navigator.id, (item) => ({
          ...item,
          mainBoardId: boardId,
          mainPaneLeafId: targetLeafId,
        })));
        io.markDirty();
        requestAnimationFrame(() => pushHistory("set-main-board"));
      }
      return;
    }

    // A board can only be mounted in one text pane at a time. If it is already
    // open, move it by swapping the destination pane's board back to its source.
    const targetPreviousBoardId = targetLeaf.textId;
    const sourceLeafId = findLeavesByTextId(currentTree, boardId)
      .find((id) => id !== targetLeafId);
    const replacementBoardId = targetLeaf.kind === "image" && sourceLeafId
      ? allocateTextBoardId(currentTree, boardHTMLRef.current, archivedTextRef.current, uid)
      : targetPreviousBoardId;
    if (targetLeaf.kind === "image" && sourceLeafId) boardHTMLRef.current[replacementBoardId] = "";
    const targetGroup = targetLeaf.kind === "text" ? (targetLeaf.textGroup ?? group) : group;
    setTree((previous) => {
      let next = targetLeaf.kind === "image"
        ? retargetLeafAsText(previous, targetLeafId, boardId, targetGroup)
        : retargetLeafTextId(previous, targetLeafId, boardId);
      if (sourceLeafId) {
        next = retargetLeafTextId(next, sourceLeafId, replacementBoardId);
        if (targetLeaf.kind === "image") {
          const navigator = findNavigatorLeaf(next);
          if (navigator) next = addNavigatorBoard(next, navigator.id, group, replacementBoardId);
        }
      }
      if (setAsAnchor) {
        const navigator = findNavigatorLeaf(next);
        if (navigator) {
          next = updateNavigator(next, navigator.id, (item) => ({
            ...item,
            mainBoardId: boardId,
            mainPaneLeafId: targetLeafId,
          }));
        }
      }
      return next;
    });
    setActiveNavigatorTextId(boardId);
    setActiveTextLeafId(targetLeafId);
    setSelectedNavigatorBoardIds([]);
    navigatorSelectionAnchorRef.current = null;
    io.markDirty();
    setSessionKey((key) => key + 1);
    requestAnimationFrame(() => {
      pushHistory(`open-${group}-board`);
      textRefs.current[boardId]?.focus?.();
    });
  };

  const setBoardAsMain = (boardId: string, paneId: string) => {
    const currentTree = treeRef.current;
    const navigator = findNavigatorLeaf(currentTree);
    if (!navigator) return;
    setTree(updateNavigator(currentTree, navigator.id, (item) => ({
      ...item,
      mainBoardId: boardId,
      mainPaneLeafId: paneId,
    })));
    io.markDirty();
    requestAnimationFrame(() => pushHistory("set-main-board"));
  };

  const openBoardInMain = (boardId: string, group: "writing" | "notes") => {
    const currentTree = treeRef.current;
    const navigator = findNavigatorLeaf(currentTree);
    const savedMainLeaf = navigator?.mainPaneLeafId
      ? findLeaf(currentTree, navigator.mainPaneLeafId)
      : undefined;
    // Anchor is bound to the pane where the author marked the Anchor Board.
    // Fall back for older projects that do not yet have a saved pane ID.
    const mainLeaf = savedMainLeaf
      || collectTextLeaves(currentTree).find((item) => (item.textGroup ?? "writing") === "writing")
      || collectTextLeaves(currentTree)[0];
    if (mainLeaf) openNavigatorBoard(boardId, group, mainLeaf.id, mainLeaf.kind, true);
  };

  const renderLeaf = (leaf: LeafNode, touchesWindowRightEdge = false) => {

    if (leaf.kind === "navigator") {
      const writingIds = leaf.writingBoardIds || collectTextLeaves(tree)
        .filter((item) => (item.textGroup ?? "writing") === "writing")
        .map((item) => item.textId);
      const notesIds = leaf.noteBoardIds || collectTextLeaves(tree)
        .filter((item) => item.textGroup === "notes")
        .map((item) => item.textId);
      const toNavigatorItems = (entries: NavigatorEntry[], group: "writing" | "notes"): NavigatorTextItem[] => entries.map((entry) =>
        entry.type === "group"
          ? {
              id: entry.id, kind: "group", label: entry.name, group, collapsed: entry.collapsed,
              children: entry.children.map((id) => ({
                id, kind: "board", group, isMain: leaf.mainBoardId === id,
                label: leaf.boardNames?.[id] || firstLineFromHTML(getInitialHTML(id), 36) || "Untitled TextBoard",
              })),
            }
          : {
              id: entry.id, kind: "board", group, isMain: leaf.mainBoardId === entry.id,
              label: leaf.boardNames?.[entry.id] || firstLineFromHTML(getInitialHTML(entry.id), 36) || "Untitled TextBoard",
            }
      );
      const writing = toNavigatorItems(navigatorEntriesForLeaf(leaf, "writing").length
        ? navigatorEntriesForLeaf(leaf, "writing") : writingIds.map((id) => ({ type: "board" as const, id })), "writing");
      const notes = toNavigatorItems(navigatorEntriesForLeaf(leaf, "notes").length
        ? navigatorEntriesForLeaf(leaf, "notes") : notesIds.map((id) => ({ type: "board" as const, id })), "notes");
      const writingVariants = writingVariantsForLeaf(leaf).map(({ id, name }) => ({ id, name }));
      const allWritingBoardIds = Array.from(new Set(
        writingVariantsForLeaf(leaf).flatMap((variant) => flattenNavigatorBoardIds(variant.entries))
      ));
      return (
        <LeafPane
          key={`leaf-${leaf.id}-${sessionKey}`}
          leafId={leaf.id}
          kind={leaf.kind}
          onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
          onRequestSplit={handleRequestSplit}
          onRequestSwap={handleSwapPanes}
          onRequestDuplicatePane={handleDuplicatePane}
          onSwapTargetChange={setSwapTargetLeafId}
          onDuplicateTargetChange={setDuplicateTargetLeafId}
          swapTargetLeafId={swapTargetLeafId}
          duplicateTargetLeafId={duplicateTargetLeafId}
          accentColor={(prefs as any)?.accentColor}
        >
          <NavigatorBoard
            writing={writing}
            notes={notes}
            writingVariants={writingVariants}
            protectedWritingBoardId={allWritingBoardIds.length === 1 ? allWritingBoardIds[0] : null}
            activeWritingVariantId={leaf.activeWritingVariantId || "main"}
            onSelectWritingVariant={(id) => {
              setTree((previous) => selectWritingVariant(previous, leaf.id, id));
              setSelectedNavigatorBoardIds([]);
              navigatorSelectionAnchorRef.current = null;
              io.markDirty();
            }}
            onAddWritingVariant={() => {
              setTree((previous) => createWritingVariant(previous, leaf.id).tree);
              setSelectedNavigatorBoardIds([]);
              navigatorSelectionAnchorRef.current = null;
              io.markDirty();
              io.notify("Draft order created.", "info", 1400);
              requestAnimationFrame(() => pushHistory("create-writing-draft"));
            }}
            onRenameWritingVariant={(id, name) => {
              setTree((previous) => renameWritingVariant(previous, leaf.id, id, name));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("rename-writing-order"));
            }}
            onDeleteWritingVariant={(id) => {
              setTree((previous) => deleteWritingVariant(previous, leaf.id, id));
              setSelectedNavigatorBoardIds([]);
              navigatorSelectionAnchorRef.current = null;
              io.markDirty();
              io.notify("Draft order deleted.", "info", 1400);
              requestAnimationFrame(() => pushHistory("delete-writing-order"));
            }}
            onReorderWritingVariant={(sourceId, targetId, position) => {
              setTree((previous) => reorderWritingVariant(previous, leaf.id, sourceId, targetId, position));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("reorder-writing-orders"));
            }}
            getBoardLabel={(id) => leaf.boardNames?.[id] || firstLineFromHTML(getInitialHTML(id), 36) || "Untitled TextBoard"}
            selectedIds={selectedNavigatorBoardIds}
            onClearSelection={() => {
              setSelectedNavigatorBoardIds([]);
              navigatorSelectionAnchorRef.current = null;
            }}
            onSelectionChange={(ids) => {
              setSelectedNavigatorBoardIds(ids);
              navigatorSelectionAnchorRef.current = ids[0] ?? null;
            }}
            onSelectBoard={(id, event) => {
              const flattenVisible = (items: NavigatorTextItem[]): string[] => items.flatMap((item) => [
                item.id,
                ...(!item.collapsed && item.children ? flattenVisible(item.children) : []),
              ]);
              const orderedIds = [...flattenVisible(writing), ...flattenVisible(notes)];
              const anchorId = navigatorSelectionAnchorRef.current;
              if (event.shiftKey && anchorId && orderedIds.includes(anchorId)) {
                const from = orderedIds.indexOf(anchorId);
                const to = orderedIds.indexOf(id);
                const range = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
                setSelectedNavigatorBoardIds(range);
              } else if (event.ctrlKey || event.metaKey) {
                setSelectedNavigatorBoardIds((current) => current.includes(id)
                  ? current.filter((selectedId) => selectedId !== id)
                  : [...current, id]);
                navigatorSelectionAnchorRef.current = id;
              } else {
                setSelectedNavigatorBoardIds([id]);
                navigatorSelectionAnchorRef.current = id;
              }
            }}
            onRenameBoard={(id, name) => {
              setTree((previous) => setNavigatorBoardName(previous, leaf.id, id, name.trim()));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("rename-navigator-board"));
            }}
            onDuplicateBoard={handleDuplicateNavigatorBoard}
            onDeleteBoard={handleNavigatorDeleteBoard}
            onDeleteBoards={handleNavigatorDeleteBoards}
            onRenameGroup={(id, group, name) => {
              setTree((previous) => renameNavigatorGroup(previous, leaf.id, group, id, name.trim()));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("rename-navigator-group"));
            }}
            onGroupSelected={(ids, group) => {
              const entries = navigatorEntriesForLeaf(leaf, group);
              if (ids.length < 1 || ids.some((id) => !entries.some((entry) => entry.type === "board" && entry.id === id))) return null;
              const allGroups = [...navigatorEntriesForLeaf(leaf, "writing"), ...navigatorEntriesForLeaf(leaf, "notes")]
                .filter((entry): entry is Extract<NavigatorEntry, { type: "group" }> => entry.type === "group");
              const nextNumber = Math.max(0, ...allGroups.map((entry) => Number(entry.name.match(/^group_(\d+)$/i)?.[1] || 0))) + 1;
              const groupId = `G${uid()}`;
              const groupName = `group_${String(nextNumber).padStart(2, "0")}`;
              setTree((previous) => groupNavigatorBoards(previous, leaf.id, group, ids, groupId, groupName));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("group-navigator-boards"));
              return groupId;
            }}
            onUngroupSelected={(ids, group) => {
              const entries = navigatorEntriesForLeaf(leaf, group);
              if (!ids.some((id) => entries.some((entry) => entry.type === "group" && entry.id === id))) return [];
              const result = ungroupNavigatorGroups(treeRef.current, leaf.id, group, ids);
              if (!result.expandedIds.length) return [];
              setTree(result.tree);
              io.markDirty();
              requestAnimationFrame(() => pushHistory("ungroup-navigator-boards"));
              return result.expandedIds;
            }}
            onToggleGroup={(id, group) => {
              setTree((previous) => toggleNavigatorGroup(previous, leaf.id, group, id));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("toggle-navigator-group"));
            }}
            onMoveBoard={(move) => {
              setTree((previous) => {
                const moved = moveNavigatorBoard(
                  previous,
                  leaf.id,
                  move.boardId,
                  move.sourceGroup,
                  move.targetGroup,
                  move.targetId,
                  move.targetParentGroupId,
                  move.position,
                );
                return move.sourceGroup === move.targetGroup
                  ? moved
                  : setTextBoardGroup(moved, move.boardId, move.targetGroup);
              });
              setSelectedNavigatorBoardIds([move.boardId]);
              navigatorSelectionAnchorRef.current = move.boardId;
              io.markDirty();
              requestAnimationFrame(() => pushHistory("move-navigator-board"));
            }}
            onMoveGroup={(move) => {
              setTree((previous) => moveNavigatorGroup(
                previous,
                leaf.id,
                move.groupId,
                move.sourceGroup,
                move.targetGroup,
                move.targetId,
                move.position,
              ));
              setSelectedNavigatorBoardIds([move.groupId]);
              navigatorSelectionAnchorRef.current = move.groupId;
              io.markDirty();
              requestAnimationFrame(() => pushHistory("move-navigator-group"));
            }}
            activeId={activeNavigatorTextId}
            accentColor={(prefs as any)?.accentColor}
            manuscriptOpen={containsLeafKind(tree, "manuscript")}
            onToggleManuscript={() => {
              setTree((prev) => toggleManuscriptView(prev, leaf.id));
              io.markDirty();
              requestAnimationFrame(() => pushHistory("manuscript-view"));
            }}
            onAddBoard={(group) => {
              const id = allocateTextBoardId(treeRef.current, boardHTMLRef.current, archivedTextRef.current, uid);
              boardHTMLRef.current[id] = "";
              setTree((prev) => retargetGroupTextBoard(
                addNavigatorBoard(prev, leaf.id, group, id), group, id
              ));
              setActiveNavigatorTextId(id);
              setSelectedNavigatorBoardIds([]);
              navigatorSelectionAnchorRef.current = null;
              io.markDirty();
              io.notify(group === "writing" ? "Writing board created." : "Note board created.", "info", 1400);
              requestAnimationFrame(() => {
                pushHistory(`add-${group}-board`);
                textRefs.current[id]?.focus?.();
              });
            }}
            onOpenInMain={(id, group) => openBoardInMain(id, group)}
          />
        </LeafPane>
      );
    }

    if (leaf.kind === "text" || leaf.kind === "scenario") {
      const curlyPref = normalizeCurlyPref(
        (prefs as any)?.curly ??
        (prefs as any)?.curlyReplace ??
        (prefs as any)?.bracketReplacement?.curly ??
        bracketToCurly((prefs as any)?.bracket)
      );
      const mappedTypefaces =
        (prefs as any).typefaces ??
        (prefs as any).typeface ??
        {
          headline: { name: baseTF.name, size: Math.round(baseTF.size * 1.35) },  
          body:     { name: baseTF.name, size: baseTF.size },
          accent:   { name: baseTF.name, size: baseTF.size },
          etc:      { name: baseTF.name, size: Math.max(12, Math.round(baseTF.size * 0.92)) },
        };
      return (
        <LeafPane
          key={`leaf-${leaf.id}-${sessionKey}`}  
          leafId={leaf.id}
          kind={leaf.kind}
          onActivate={() => {
            setSelectedNavigatorBoardIds([]);
            navigatorSelectionAnchorRef.current = null;
            setActiveNavigatorTextId(leaf.textId);
            setActiveTextLeafId(leaf.id);
          }}
          dropGroup="any"
          onDropNavigatorBoard={(item) => openNavigatorBoard(item.boardId, item.group, leaf.id, leaf.kind)}
          onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
          onRequestSplit={handleRequestSplit}
          onRequestSwap={handleSwapPanes}
          onRequestDuplicatePane={handleDuplicatePane}
          onSwapTargetChange={setSwapTargetLeafId}
          onDuplicateTargetChange={setDuplicateTargetLeafId}
          swapTargetLeafId={swapTargetLeafId}
          duplicateTargetLeafId={duplicateTargetLeafId}
          canDuplicate={leaf.kind === "text"}
          accentColor={(prefs as any)?.accentColor}
        >
        <TextBoard
          ref={(h) => { textRefs.current[leaf.textId] = h; }}
          key={`${sessionKey}:${leaf.id}:${leaf.textId}`}
          id={leaf.textId}
          scenario={leaf.kind === "scenario"}
          touchesWindowRightEdge={touchesWindowRightEdge}
          accentColor={(prefs as any)?.accentColor}
          initialHTML={getInitialHTML(leaf.textId)}
          onChange={(html) => handleBoardChange(leaf.textId, html)}
          color="var(--text-1)"
          inset={{ top: 0, left: 0 }}
          preset={preset as 1 | 2 | 3 | 4}
          presetSeq={presetSeq}
          onPresetChange={(n: 1 | 2 | 3 | 4) => setPreset(n)}
          typefaces={mappedTypefaces}
          paragraphIndent={prefs.paragraphIndent}
          writingGoal={(prefs as any)?.writingGoal}
          curly={curlyPref}
          onHUDChange={(s) => setActivePreset(s.preset)}
        />
        </LeafPane>
      );
    }

    if (leaf.kind === "viewer") {
      return (
        <LeafPane
          key={`leaf-${leaf.id}-${sessionKey}`}
          leafId={leaf.id}
          kind={leaf.kind}
          onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
          onRequestSplit={handleRequestSplit}
          onRequestSwap={handleSwapPanes}
          onRequestDuplicatePane={handleDuplicatePane}
          onSwapTargetChange={setSwapTargetLeafId}
          onDuplicateTargetChange={setDuplicateTargetLeafId}
          swapTargetLeafId={swapTargetLeafId}
          duplicateTargetLeafId={duplicateTargetLeafId}
          accentColor={(prefs as any)?.accentColor}
        >
          <ViewerBoard
            ref={(h) => { viewerRefs.current[leaf.id] = h; }}
            state={viewerStates[leaf.id] || { fileLabel: "", boards: [], selectedId: "", q: "" }}
            onChange={(patch) => setViewerStates(m => ({ ...m, [leaf.id]: { ...(m[leaf.id] || {fileLabel:"", boards:[], selectedId:"", q:""}), ...patch } }))}
          />
        </LeafPane>
      );
    }

    if (leaf.kind === "manuscript") {
      const navigator = findNavigatorLeaf(tree);
      const boardIds = navigator
        ? flattenNavigatorBoardIds(navigatorEntriesForLeaf(navigator, "writing"))
        : collectTextLeaves(tree).filter((item) => (item.textGroup ?? "writing") === "writing").map((item) => item.textId);
      const manuscriptHtml = () => {
        flushOpenEditorsToStore();
        return boardIds.map((id) => `<section>${getInitialHTML(id)}</section>`).join("\n");
      };
      const manuscriptPlain = () => {
        flushOpenEditorsToStore();
        const parts = boardIds.map((id) => {
          const container = document.createElement("div");
          container.innerHTML = getInitialHTML(id) || "";
          return htmlToPlainText(container, prefs.paragraphIndent);
        }).filter(Boolean);
        return parts.join("\n\n");
      };
      return (
        <LeafPane
          key={`leaf-${leaf.id}-${sessionKey}`}
          leafId={leaf.id}
          kind={leaf.kind}
          onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
          onRequestSplit={handleRequestSplit}
          onRequestSwap={handleSwapPanes}
          onRequestDuplicatePane={handleDuplicatePane}
          onSwapTargetChange={setSwapTargetLeafId}
          onDuplicateTargetChange={setDuplicateTargetLeafId}
          swapTargetLeafId={swapTargetLeafId}
          duplicateTargetLeafId={duplicateTargetLeafId}
          accentColor={(prefs as any)?.accentColor}
        >
          <ManuscriptBoard boardIds={boardIds} gapLines={prefs.manuscriptGapLines ?? 1}
            paragraphIndent={prefs.paragraphIndent}
            getHTML={(id) => getInitialHTML(id)}
            getBoardName={(id) => navigator?.boardNames?.[id] || firstLineFromHTML(getInitialHTML(id), 36) || "Untitled TextBoard"}
            onExportTxt={() => void onExportTxt(manuscriptPlain)}
            onExportPdf={() => void onExportPrint(manuscriptHtml)} />
        </LeafPane>
      );
    }

    if (leaf.kind === "edit") {
      return (
        <LeafPane
          key={`leaf-${leaf.id}-${sessionKey}`}
          leafId={leaf.id}
          kind={leaf.kind}
          onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
          onRequestSplit={handleRequestSplit}
          onRequestSwap={handleSwapPanes}
          onRequestDuplicatePane={handleDuplicatePane}
          onSwapTargetChange={setSwapTargetLeafId}
          onDuplicateTargetChange={setDuplicateTargetLeafId}
          swapTargetLeafId={swapTargetLeafId}
          duplicateTargetLeafId={duplicateTargetLeafId}
          accentColor={(prefs as any)?.accentColor}
        >
          <EditBoard onDeleteRequest={handleDeleteBoards} />
        </LeafPane>
      );
    }

    const im = imageDocs[leaf.imageId] ?? { src: null as string | null, view: undefined };

    return (
      <LeafPane
        key={`leaf-${leaf.id}-${sessionKey}`}
        leafId={leaf.id}
        kind={leaf.kind}
        dropGroup="any"
        onDropNavigatorBoard={(item) => openNavigatorBoard(item.boardId, item.group, leaf.id, leaf.kind)}
        onOpenMenu={(id, pt, src) => openMenuFor(id, pt, src)}
        onRequestSplit={handleRequestSplit}
        onRequestSwap={handleSwapPanes}
        onRequestDuplicatePane={handleDuplicatePane}
        onSwapTargetChange={setSwapTargetLeafId}
        onDuplicateTargetChange={setDuplicateTargetLeafId}
        swapTargetLeafId={swapTargetLeafId}
        duplicateTargetLeafId={duplicateTargetLeafId}
        accentColor={(prefs as any)?.accentColor}
      >
        <ImageBoard
          ref={(h) => {
            imageRefs.current[leaf.imageId] = h;
          }}
          data-role="imageboard"
          data-image-id={leaf.imageId}
          src={im.src}
          displayPath={imagePaths[leaf.imageId] || null} 
          forceMissing={!!imageMissing[leaf.imageId]}
          background="var(--bg)"
          inset={{ top: 0, left: 0 }}
          onOpenContextMenu={(x, y) => openMenuFor(leaf.id, { x, y }, "content")}
          onViewChange={(view) => {
            setImageDocs((m) => {
              const prev = m[leaf.imageId] ?? im;
              return { ...m, [leaf.imageId]: { src: prev.src, view } };
            });
          }}
        />
      </LeafPane>
    );
  };

  const LEAF_MIN_W = 48; 
  const TEXT_LEAF_MIN_W = 220;
  const LEAF_MIN_H = 48; 
  const GUTTER_PX  = 1;

  function subtreeMinWidth(n: TreeNode): number {
    if (!n) return LEAF_MIN_W;
    if (n.type === "leaf") {
      if (n.kind === "navigator") return 176;
      if ((n.kind === "text" || n.kind === "scenario") && (n.textGroup ?? "writing") === "writing") {
        return TEXT_LEAF_MIN_W;
      }
      return LEAF_MIN_W;
    }
    if (n.dir === "vertical") {
      return subtreeMinWidth(n.a) + GUTTER_PX + subtreeMinWidth(n.b);
    }
    return Math.max(subtreeMinWidth(n.a), subtreeMinWidth(n.b));
  }

  function subtreeMinHeight(n: TreeNode): number {
    if (!n || n.type === "leaf") return LEAF_MIN_H;
    if (n.dir === "horizontal") {
      return subtreeMinHeight(n.a) + GUTTER_PX + subtreeMinHeight(n.b);
    }
    return Math.max(subtreeMinHeight(n.a), subtreeMinHeight(n.b));
  }

  const [draggingPath, setDraggingPath] = React.useState<string | null>(null);
  const [swapTargetLeafId, setSwapTargetLeafId] = React.useState<string | null>(null);
  const [duplicateTargetLeafId, setDuplicateTargetLeafId] = React.useState<string | null>(null);

  const subtreeHasKind = (node: TreeNode, kind: LeafKind): boolean => node.type === "leaf"
    ? node.kind === kind
    : subtreeHasKind(node.a, kind) || subtreeHasKind(node.b, kind);

  const renderNode = (node: TreeNode, path: number[] = [], touchesWindowRightEdge = true): React.ReactNode => {
    if (node.type === "leaf") {
      return renderLeaf(node, touchesWindowRightEdge);
    }

    // Compute child subtree minimum sizes (px)
    const minApx =
      node.dir === "vertical" ? subtreeMinWidth(node.a) : subtreeMinHeight(node.a);
    const minBpx =
      node.dir === "vertical" ? subtreeMinWidth(node.b) : subtreeMinHeight(node.b);
    const insetGutter = node.dir === "vertical" && (
      (subtreeHasKind(node.a, "navigator") && subtreeHasKind(node.b, "manuscript")) ||
      (subtreeHasKind(node.b, "navigator") && subtreeHasKind(node.a, "manuscript"))
    );

    return (
      <SplitPane
        key={`split-${path.join("") || "root"}`}
        direction={node.dir}
        ratio={node.ratio}
        onChange={(r) => onChangeRatio(r, path, node.dir)} 
        gutterSize={GUTTER_PX}
        minA={minApx}
        minB={minBpx}
        pathKey={path.join(".")}
        insetGutter={insetGutter}
        onDragStart={() => setDraggingPath(path.join("."))}
        onDragEnd={() => setDraggingPath(null)}
        a={renderNode(node.a, [...path, 0], node.dir === "vertical" ? false : touchesWindowRightEdge)}
        b={renderNode(node.b, [...path, 1], touchesWindowRightEdge)}
      />
    );
  };

  /* ---------- Context menu items ---------- */
  const menuItems = React.useMemo(() => {
    if (!menu.leafId) return [];
    const leaf = findLeaf(tree, menu.leafId);
    if (!leaf) return [];

    if (menu.source === "content") {
      if (leaf.kind === "manuscript" || leaf.kind === "navigator") return [];
      if (leaf.kind === "image") {
        const imageId = leaf.imageId;
        const src = imageDocs[imageId]?.src ?? null;
        const getEcho = (): string | null => (window as any).__SW_ECHO_BG__ ?? null;
        const setEcho = (s: string | null) => {
          (window as any).__SW_ECHO_BG__ = s;
          window.dispatchEvent(new Event("sw:echo-bg-changed"));
        };

        const isChecked = !!src && getEcho() === src;
        const toggleEcho = () => {
          if (!src) return;
          setEcho(isChecked ? null : src);
          io.markDirty();                    
        };

        return [
          { label: "Change Image…", onClick: () => triggerChangeImage(imageId) },
          { label: "Reset position", onClick: () => imageRefs.current[imageId]?.resetView?.() },
          { label: `${isChecked ? "✓ " : ""}Use as Echo background`, onClick: toggleEcho },
        ];
      }

      const { id: boardId, typewriter } = getBoardState();

      return [
        {
          label: "Copy",
          onClick: () => document.execCommand("copy"),
          disabled: !window.getSelection()?.toString(),
        },
        {
          label: "Paste",
          onClick: async () => {
            try {
              const txt = await navigator.clipboard.readText();
              document.execCommand("insertText", false, txt);
            } catch {}
          },
        },
        {
          label: `${typewriter ? "✓ " : ""}Typewriter`,
          disabled: !boardId,
          onClick: () => boardId && emitTextToggle(boardId, "typewriter"),
        },
        {
          label: "Set Echo View Start Here",
          disabled: !boardId,
          onClick: () => boardId && window.dispatchEvent(new CustomEvent("sw:echo:set-start", { detail: { id: boardId } })),
        },
        {
          label: "Clear Echo View Start",
          disabled: !boardId,
          onClick: () => boardId && window.dispatchEvent(new CustomEvent("sw:echo:clear-start", { detail: { id: boardId } })),
        },
        ...(leaf.kind === "text" || leaf.kind === "scenario" ? [{
          label: (findNavigatorLeaf(tree)?.mainBoardId || collectTextLeaves(tree).find((item) => (item.textGroup ?? "writing") === "writing")?.textId) === boardId
            ? "✓ Anchor Board"
            : "Set as Anchor Board",
          disabled: !boardId,
          onClick: () => boardId && setBoardAsMain(boardId, leaf.id),
        }] : []),
      ];
    }

    if (menu.pane === "root") {
      if (leaf.kind === "navigator") {
        return [
          { label: "Change Board Type >", onClick: keepOpenOnce(() => gotoPane("text:changeType")) },
          {
            label: "Close board",
            onClick: () => {
              setTree((t) => removeLeaf(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id));
              io.markDirty();
            },
          },
        ];
      }

      if (leaf.kind === "text" || leaf.kind === "scenario") {
        const mainBoardId = findNavigatorLeaf(tree)?.mainBoardId;
        return [
          { label: "Change Board Type >", onClick: keepOpenOnce(() => gotoPane("text:changeType")) },
          {
            label: mainBoardId === leaf.textId ? "✓ Anchor Board" : "Set as Anchor Board",
            onClick: () => setBoardAsMain(leaf.textId, leaf.id),
          },
          { label: "Export as >", onClick: keepOpenOnce(() => gotoPane("text:export")) },
          { label: "", separator: true, disabled: true },
          {
            label: "Close board",
            onClick: () => {
              const text = boardHTMLRef.current[leaf.textId] ?? "";
              if (text.length > 12) setArchivedText((m) => ({ ...m, [leaf.textId]: text }));
              setTree((t) => removeLeaf(t, leaf.id));
              io.markDirty(); 
            },
          },
        ];
      }

      if (leaf.kind === "manuscript") {
        return [{
          label: "Close board",
          onClick: () => {
            setTree((t) => removeLeaf(t, leaf.id));
            io.markDirty();
          },
        }];
      }

      if (leaf.kind === "viewer") {
        return [
          { label: "Change Board Type >", onClick: keepOpenOnce(() => gotoPane("image:changeType")) },

          {
            label: "Duplicate here",
            onClick: () => {
              const sel = viewerRefs.current[leaf.id]?.getSelected?.();
              if (!sel) {
                io.notify("Pick a board in Viewer first.");
                return;
              }
              const newId = allocateTextBoardId(treeRef.current, boardHTMLRef.current, archivedTextRef.current, uid);
              boardHTMLRef.current[newId] = sel.html || "";
              setTree(t => {
                let r = changeKind(t, leaf.id, "text");
                r = retargetLeafTextId(r, leaf.id, newId);
                return r;
              });
              io.markDirty();
              setSessionKey(k => k + 1);
              io.notify(`Duplicated Textboard"${sel.id}" here.`);
              pushHistory("viewer-duplicate");
            },
          },

          {
            label: "Close board",
            onClick: () => {
              setTree(t => removeLeaf(t, leaf.id));
              io.markDirty();
            },
          },
        ];
      }

      if (leaf.kind === "edit") {
        return [
          { label: "Change Board Type >", onClick: keepOpenOnce(() => gotoPane("text:changeType")) },
          {
            label: "Close board",
            onClick: () => {
              setTree((t) => removeLeaf(t, leaf.id));
              io.markDirty();
            },
          },
        ];
      }

      if (leaf.kind === "image") {
        return [
          { label: "Change Board Type >", onClick: keepOpenOnce(() => gotoPane("image:changeType")) },
          { label: "Duplicate to subfolder", onClick: () => void duplicateImageToProject(leaf.imageId) },
          {
            label: "Close board",
            onClick: () => {
              const im = imageDocs[leaf.imageId] ?? { src: null as string | null, view: undefined };
              setArchivedImage((m) => ({ ...m, [leaf.imageId]: im }));
              setTree((t) => removeLeaf(t, leaf.id));
              io.markDirty();
              pushHistory("image-view");
            },
          },
        ];
      }
    }

    if (menu.pane === "text:changeType") {
      const changeToText = () => {
        setTree((t) => changeTextBoardKind(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "text"));
        io.markDirty();
      };
      return [
        { label: "Text",   onClick: changeToText },
        { label: "Image",  onClick: () => { setTree((t) => replaceLeafWithNew(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "image"));  io.markDirty(); } },
        { label: "Navigator", onClick: () => { setTree((t) => replaceLeafWithNew(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "navigator")); io.markDirty(); } },
      ];
    }
    if (menu.pane === "text:export") {
      const leafId = leaf.id;
      const textId = leaf.textId;

      const fetchPlain = () => {
        const viaRef = textRefs.current[textId]?.getPlainText?.();
        if (typeof viaRef === "string") return viaRef;
        const root = document.querySelector(
          `[data-board-id="${leafId}"] [data-role="editor-root"], ` +
          `[data-board-id="${leafId}"] [contenteditable="true"]`
        ) as HTMLElement | null;
        return root ? htmlToPlainText(root, prefsRef.current.paragraphIndent) : "";
      };

      const fetchHTML = () => {
        const root = document.querySelector(
          `[data-board-id="${leafId}"] [data-role="editor-root"], ` +
          `[data-board-id="${leafId}"] [contenteditable="true"]`
        ) as HTMLElement | null;
        return root?.innerHTML || "";
      };

      return [
        { label: "TXT", onClick: () => onExportTxt(fetchPlain) },
        { label: "PDF", onClick: () => onExportPrint(fetchHTML) },
      ];
    }

    if (menu.pane === "image:changeType") {
      const changeToText = () => {
        setTree((t) => changeTextBoardKind(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "text"));
        io.markDirty();
      };
      return [
        { label: "Text",   onClick: changeToText },
        { label: "Image",  onClick: () => { setTree((t) => replaceLeafWithNew(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "image"));  io.markDirty(); } },
        { label: "Navigator", onClick: () => { setTree((t) => replaceLeafWithNew(closeManuscriptBeforeNavigatorMutation(t, leaf.id), leaf.id, "navigator")); io.markDirty(); } },
      ];
    }

    return [];
  }, [
    menu.open, menu.pane, menu.leafId, menu.source,
    tree, imageDocs,
  ]);

  const accentStyle = React.useMemo(
    () =>
      (prefs as any)?.accentColor
        ? ({ ["--accent" as any]: (prefs as any).accentColor } as React.CSSProperties)
        : {},
    [(prefs as any)?.accentColor]
  );

  return (
    <div 
      data-app-root
      data-dragging={draggingPath ? "1" : "0"}
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        gridTemplateRows: `${TITLEBAR_H}px ${TOPBAR_H}px 1fr`,
        background: "var(--topbar)",
        color: "var(--text-1)",
        minWidth: 0,
        minHeight: 0,
        zIndex: 0, 
      }}
      onMouseDown={() => {
        window.__CTX_TARGET__ = null; 
        setMenu((m) => ({ ...m, open: false }));
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Title bar */}
      <div style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
        <TitleBar />
      </div>

      {/* Top bar */}
      <div style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
        <TopBar
          activePreset={activePreset}
          onPresetClick={(n) => { setPreset(n); setPresetSeq(x => x + 1); }}
          onToggleSidebar={() => setShowSidebar((v) => !v)}
          onOpenAbout={() => setShowAbout(true)}
          onOpenPreferences={() => setShowPrefs(true)}
          accentColor={(prefs as any)?.accentColor}
        />
      </div>

      {/* Content */}
      <div
        style={{
          position: "relative",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {renderNode(tree)}

        {showPrefs && (
          <PreferenceModal
            prefs={prefs}
            autosaveOverride={autosaveSessionOverride}
            onAutosaveToggle={(enabled) => window.dispatchEvent(new CustomEvent("sw:autosave:toggle-for-file", { detail: { enabled } }))}
            onChange={async (next: PrefsType) => {
              setPrefs(next);
              if ((next as any)?.workingFolder) setWorkingFolder((next as any).workingFolder);
              try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next)); } catch {}
              void writeLocalPrefsFile(next); 
            }}
            onClose={() => setShowPrefs(false)}
          />
        )}

        {showAbout && (
          <Modal onClose={() => setShowAbout(false)} width={420} background="var(--topbar)" >
            <AboutPanel theme={(prefs as any)?.theme ?? "dark"} />
          </Modal>
        )}
      </div>
      
      {/* Sidebar overlay – 전체 창 덮기 */}
      {showSidebar && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 280,
            // Keep the Sidebar's interaction accents tied to the user's project accent.
            ...((prefs as any)?.accentColor ? {
              ["--accent" as any]: (prefs as any).accentColor,
              ["--sb-hover" as any]: "color-mix(in srgb, var(--accent) 16%, transparent)",
              ["--sb-selected" as any]: "color-mix(in srgb, var(--accent) 16%, transparent)",
              ["--sb-btn-bg-hover" as any]: "color-mix(in srgb, var(--accent) 16%, var(--sb-bg))",
            } : {}),
            background: "var(--sb-bg)",
            borderRight: "1px solid var(--sb-border)",
            boxShadow: "8px 0 24px rgba(0,0,0,0.35)",
            zIndex: 2000,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Sidebar
            open={showSidebar}
            onClose={() => setShowSidebar(false)}
            workingFolder={workingFolder}
            onOpenFile={async (absPath: string) => {
              try {
                await openByPath(absPath);
              } catch (e) {
                console.error(e);
                io.notify?.("Failed to open project.", "error", 2000);
              }
            }}
            onSave={async () => { await save(); }}
            onSaveAs={async () => { await saveAsAndBind(); }}
            onNew={async () => { await newWithGuard(); }}
            onArchive={() => io.notify("Archive will be available in version 3.0.", "info", 2200)}
            onQuit={async () => { await quitWithGuard(); }}
          />
        </div>
      )}

      {ask3State.open && (
        <Modal onClose={() => { ask3State.resolve?.("cancel"); setAsk3State({open:false, msg:""}); }} width={420} backdrop="rgba(0,0,0,.34)">
          <div style={{ padding: 16 }}>
            <div style={{ ["--exit-accent" as any]: (prefs as any)?.accentColor || "var(--accent)" }}>
            <style>{`
              .sw-exit-action:hover,
              .sw-exit-action:focus-visible {
                background: color-mix(in srgb, var(--exit-accent) 16%, var(--btn-bg)) !important;
                border-color: color-mix(in srgb, var(--exit-accent) 58%, var(--border)) !important;
                outline: none;
              }
            `}</style>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Splitwriter</div>
            <div style={{ fontSize: 13, opacity: 0.9, whiteSpace: "pre-wrap" }}>{ask3State.msg}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button
                className="sw-exit-action"
                onClick={() => { ask3State.resolve?.("save"); setAsk3State({open:false, msg:""}); }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--btn-bg)", color: "var(--text-1)", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                {ask3State.labels?.save || "Save and Quit"}
              </button>
              <button
                className="sw-exit-action"
                onClick={() => { ask3State.resolve?.("discard"); setAsk3State({open:false, msg:""}); }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--btn-bg)", color: "var(--text-1)", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                {ask3State.labels?.discard || "Quit without Save"}
              </button>
              <button
                className="sw-exit-action"
                onClick={() => { ask3State.resolve?.("cancel"); setAsk3State({open:false, msg:""}); }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--btn-bg)", color: "var(--text-1)", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                {ask3State.labels?.cancel || "Cancel"}
              </button>
            </div>
            </div>
          </div>
        </Modal>
      )}

      {menu.open && (
        <div style={accentStyle} onMouseDown={(e) => e.stopPropagation()}>
          <style>{`
            .ctxmenu-item:hover,
            .ctxmenu-item.is-active,
            .ctxmenu-item[aria-current="true"],
            .ctxmenu-item[data-active="true"],
            .ctxmenu-item[aria-selected="true"] {
              background: color-mix(in srgb, var(--accent) 12%, transparent) !important;
              box-shadow: none !important;
              border: none !important;
            }
          `}</style>

          <ContextMenu
            open={menu.open}
            x={menu.x}
            y={menu.y}
            items={menuItems}
            accentColor={(prefs as any)?.accentColor}
            onClose={() => {
              if (deferCloseRef.current) { deferCloseRef.current = false; return; }
              closeMenu();
            }}
          />
        </div>
      )}

      {/* // Shared, hidden file input for images */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{
          position: "fixed",
          left: "-9999px",
          top: 0,
          width: 0,
          height: 0,
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={onPickImage}
      />
    <style>{`
      .sw-pane{width:100%;height:100%;}
      .sw-pane > .sw-cell{width:100%;height:100%;min-width:0;min-height:0;}
      [data-dragging="1"] .sw-pane{transition:none!important}
    `}</style>
    </div>
  );
}

/* ---------- Small Modal ---------- */
function Modal({
  children,
  onClose,
  width = 560,
  background = "var(--bg)",  
  backdrop = "transparent",
}: {
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
  background?: string;
  backdrop?: string;
}) {
  return (
    <div
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 5000, background: backdrop }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 48px)",
          background,              
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          overflow: "auto",
          color: "var(--text-1)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- About panel (minimal + keycaps) ---------- */
function AboutPanel({ theme = "dark" }: { theme?: "dark" | "light" }) {
  const Key: React.FC<React.PropsWithChildren> = ({ children }) => (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 6,
        background: "var(--hover)",
        border: "1px solid var(--border)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: "16px",
        verticalAlign: "middle",
      }}
    >
      {children}
    </span>
  );

  const Keys = ({ parts }: { parts: string[] }) => (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ opacity: 0.6 }}>+</span>}
          <Key>{p}</Key>
        </React.Fragment>
      ))}
    </span>
  );

  const Row = ({ k, v, wideValue = false }: { k: React.ReactNode; v: React.ReactNode; wideValue?: boolean }) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: wideValue ? "minmax(76px, 0.7fr) minmax(0, 1.3fr)" : "minmax(0, 1fr) minmax(0, auto)",
        alignItems: "center",
        gap: 12,
        padding: "6px 0",
      }}
    ><span style={{ opacity: 0.75, minWidth: 0 }}>{k}</span>
      <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 4, minWidth: 0, maxWidth: "100%", textAlign: "right", lineHeight: wideValue ? 1.4 : undefined, overflowWrap: wideValue ? "anywhere" : undefined }}>{v}</span>
    </div>
  );

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ marginTop: 22 }}>
      <div
        style={{
          fontSize: 12,
          letterSpacing: 0.3,
          color: "var(--text-muted)",
          marginBottom: 9,
        }}
      >
        {title}
      </div>
      <div>{children}</div>
    </div>
  );

  const REPO_URL = "https://github.com/crom-foo/Splitwriter";

  // theme 에 따라 다크/라이트 배너 선택 (파일만 준비되어 있으면 바로 교체됨)
  const aboutLogo =
    theme === "light"
      ? new URL("./logo/Logo_Banner_Light.png", import.meta.url).href
      : new URL("./logo/Logo_Banner_Dark.png", import.meta.url).href;

  return (
    <div
      className="sw-about"
      style={{ padding: 16 }}
    >
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        {/* 로고 배너 */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <img
            src={aboutLogo}
            alt="Splitwriter — For all creators — past, present, and future."
            style={{
              display: "block",
              width: "100%",
              maxWidth: 560, // 420px 버전으로 다시 뽑으면 여기만 420으로 줄이면 됨
              height: "auto",
            }}
          />
        </div>

        {/* 버전 + 크레딧 */}
        {/* Version / Repo / Credit — one row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr) auto",
            alignItems: "baseline",
            columnGap: 12,
            fontSize: 9,
            lineHeight: "12px",
            marginTop: 0,
          }}
        >
          {/* left: version */}
          <span style={{ opacity: 0.8, whiteSpace: "nowrap" }}>
            <AppVersion fallback="v2.0-portable" />
          </span>

          {/* center: repo link (accent only) */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              justifySelf: "stretch",
              textAlign: "center",
              color: "var(--text-muted)",
              textDecoration: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "block",
              opacity: 0.95,
            }}
            title={REPO_URL}
          >
            {REPO_URL}
          </a>

          {/* right: credit */}
          <span style={{ opacity: 0.7, whiteSpace: "nowrap", textAlign: "right" }}>
            Created by Crom &amp; GPT
          </span>
        </div>
      </div>

      <div
        style={{
          height: 1,
          background: "var(--topbar-divider)",
          margin: "10px 0 12px",
        }}
      />

      {/* SHORTCUTS */}
      <Section title="SHORTCUTS">
        <Row k="Sidebar" v={<Keys parts={["Ctrl", "\\"]} />} />
        <Row k="New file" v={<Keys parts={["Ctrl", "N"]} />} />
        <Row k="Open file" v={<Keys parts={["Ctrl", "O"]} />} />
        <Row k="Save" v={<Keys parts={["Ctrl", "S"]} />} />
        <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.45, marginTop: -3 }}>
          Manual saves (Ctrl+S or Save) keep up to 10 previous versions in a _Backups folder beside the project when there are changes. Repeated saves without edits do not add backups; autosave does not create them.
        </div>
        <Row k="Save As" v={<Keys parts={["Ctrl", "Shift", "S"]} />} />
        <Row k="Undo" v={<Keys parts={["Ctrl", "Z"]} />} />
        <Row k="Redo" v={<Keys parts={["Ctrl", "Y"]} />} />
        <Row k="Midline ellipsis (⋯)" v={<Keys parts={["Alt", "M"]} />} />
        <Row k="Middle dot (·)" v={<Keys parts={["Alt", "."]} />} />
        <Row k="Em dash (—)" v={<Keys parts={["Alt", "-"]} />} />
      </Section>

      <Section title="NAVIGATOR">
        <Row k="Group boards" v={<Keys parts={["Ctrl", "G"]} />} />
        <Row k="Ungroup boards" v={<Keys parts={["Shift", "G"]} />} />
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 6 }}>
          Select boards with Ctrl- or Shift-click before grouping.
        </div>
      </Section>

      <Section title="PANE LAYOUT">
        <Row wideValue k="Split" v={<span>Drag handle within pane</span>} />
        <Row wideValue k="Swap" v={<span>Drag handle onto another pane</span>} />
        <Row wideValue k="Duplicate" v={<span>Hold Ctrl while dragging a TextBoard handle</span>} />
      </Section>

      {/* PRESET */}
      <Section title="PRESET">
        <Row
          k="Headline (H)"
          v={
            <>
              <Keys parts={["Ctrl", "1"]} />
              &nbsp;or&nbsp;
              <Keys parts={["Alt", "1"]} />
            </>
          }
        />
        <Row
          k="Body (B)"
          v={
            <>
              <Keys parts={["Ctrl", "2"]} />
              &nbsp;or&nbsp;
              <Keys parts={["Alt", "2"]} />
            </>
          }
        />
        <Row
          k="Accent (A)"
          v={
            <>
              <Keys parts={["Ctrl", "3"]} />
              &nbsp;or&nbsp;
              <Keys parts={["Alt", "3"]} />
            </>
          }
        />
        <Row
          k="Etc (E)"
          v={
            <>
              <Keys parts={["Ctrl", "4"]} />
              &nbsp;or&nbsp;
              <Keys parts={["Alt", "4"]} />
            </>
          }
        />
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 6 }}>
          If text is selected, only the selection changes. If nothing is selected, the style applies to text you type
          next.
        </div>
      </Section>

      {/* FORMATTING */}
      <Section title="FORMATTING">
        <Row k="Bold (Selected only)" v={<Keys parts={["Ctrl", "B"]} />} />
        <Row k="Italic (Selected only)" v={<Keys parts={["Ctrl", "I"]} />} />
        <Row k="Align Left" v={<Keys parts={["Alt", "L"]} />} />
        <Row k="Align Center" v={<Keys parts={["Alt", "C"]} />} />
        <Row k="Align Right" v={<Keys parts={["Alt", "R"]} />} />
        <Row k="Align Justify" v={<Keys parts={["Alt", "J"]} />} />
      </Section>

    </div>
  );
}
