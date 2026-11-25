// src/windows/swon.ts
import type { ImageView } from "./boards/ImageBoard";

/**
 * SWON I/O (save/load/new) for Splitwriter.
 * Persists: (1) split layout + Navigator variants, (2) open/archived text,
 *           (3) image src + view, (4) project profile prefs such as accent color,
 *           (5) main-window bounds, (6) echo background.
 * Supports Tauri (@tauri-apps/*) and the web (File System Access API + anchor fallback).
 */

export type SwonView = ImageView;

/** Image payload persisted in the SWON. `src` may be an absolute path or a URL. */
export type SwonImage = { src: string | null; view?: SwonView; file?: string | null };
export type SwonWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

export type NotifyLevel = "info" | "warn" | "error";
export type NotifyFn = (text: string, level?: NotifyLevel, ttlMs?: number) => void;

/** Project layout tree (split panes + leaves). */
export type SwonTree =
  | {
      type: "leaf";
      id: string;
      kind: "text" | "scenario" | "image" | "viewer" | "edit" | "navigator" | "manuscript";
      textId: string;
      imageId: string;
      textGroup?: "writing" | "notes";
      writingBoardIds?: string[];
      noteBoardIds?: string[];
      writingEntries?: ({ type: "board"; id: string } | { type: "group"; id: string; name: string; collapsed: boolean; children: string[] })[];
      writingVariants?: { id: string; name: string; entries: ({ type: "board"; id: string } | { type: "group"; id: string; name: string; collapsed: boolean; children: string[] })[] }[];
      activeWritingVariantId?: string;
      noteEntries?: ({ type: "board"; id: string } | { type: "group"; id: string; name: string; collapsed: boolean; children: string[] })[];
      boardNames?: Record<string, string>;
      mainPaneLeafId?: string;
      mainBoardId?: string;
    }
  | {
      type: "split";
      dir: "vertical" | "horizontal";
      ratio: number;
      a: SwonTree;
      b: SwonTree;
    };

/** On-disk file format. */
export type SwonFile = {
  kind: "splitwriter";
  version: 1;
  tree: SwonTree;
  openText: Record<string, string>;
  archivedText: Record<string, string>;
  images: Record<string, SwonImage>;
  prefs?: any;
  window?: SwonWindowState;
  echoBg?: string | null;
  savedAt?: string; // ISO timestamp
  title?: string; // filename hint (without .swon) for web flows
};

function normalizeWindowState(value: any): SwonWindowState | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((part) => Number.isFinite(part))) return null;
  if (width < 320 || height < 240) return null;
  return { x, y, width, height, maximized: value.maximized === true };
}

function hasRecoverableText(html: string | undefined): boolean {
  if (!html) return false;
  const withoutEmptyBlocks = html
    .replace(/<br\b[^>]*\/?\s*>/gi, "")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u200B-\u200D\uFEFF\s]/g, "");
  if (withoutEmptyBlocks.length > 0) return true;
  // Preserve non-text payloads if a future editor stores them in a text board.
  return /<(?:img|video|audio|svg|table|iframe|object)\b/i.test(html);
}

function normalizeLegacyNavigator(tree: SwonTree, openText: Record<string, string>): SwonTree {
  const leaves: Extract<SwonTree, { type: "leaf" }>[] = [];
  const collectLeaves = (node: SwonTree) => {
    if (node.type === "leaf") leaves.push(node);
    else {
      collectLeaves(node.a);
      collectLeaves(node.b);
    }
  };
  collectLeaves(tree);
  const navigator = leaves.find((leaf) => leaf.kind === "navigator");
  if (!navigator) return tree;

  const entriesForIds = (ids: string[]) => ids.map((id) => ({ type: "board" as const, id }));
  const flatten = (entries: NonNullable<typeof navigator.writingEntries>) => entries.flatMap((entry) =>
    entry.type === "board" ? [entry.id] : entry.children);
  const writingLeaves = leaves.filter((leaf) => leaf.kind === "text" && (leaf.textGroup ?? "writing") === "writing");
  const noteLeaves = leaves.filter((leaf) => leaf.kind === "text" && leaf.textGroup === "notes");
  const writingLeafIds = [...new Set(writingLeaves.map((leaf) => leaf.textId))];
  const noteLeafIds = [...new Set(noteLeaves.map((leaf) => leaf.textId))];
  const variants = navigator.writingVariants || [];
  const hasLegacyFields = !variants.length || !navigator.noteEntries?.length || !navigator.writingEntries?.length;
  if (!hasLegacyFields) return tree;

  const existingWritingIds = [...new Set([
    ...(navigator.writingBoardIds || []),
    ...(navigator.writingEntries ? flatten(navigator.writingEntries) : []),
    ...variants.flatMap((variant) => flatten(variant.entries)),
  ])];
  const baseWritingIds = existingWritingIds.length ? existingWritingIds : writingLeafIds;
  const completeWritingIds = [...new Set([...baseWritingIds, ...writingLeafIds])];
  let nextVariants = variants.length
    ? variants.map((variant) => ({
        ...variant,
        entries: [...variant.entries, ...completeWritingIds
          .filter((id) => !flatten(variant.entries).includes(id))
          .map((id) => ({ type: "board" as const, id }))],
      }))
    : [{ id: "main", name: "Main", entries: entriesForIds(completeWritingIds) }];

  if (nextVariants.length && !nextVariants.some((variant) => variant.id === "main")) {
    nextVariants = [{ id: "main", name: "Main", entries: entriesForIds(writingLeafIds) }, ...nextVariants];
  }
  const activeId = navigator.activeWritingVariantId || "main";
  const activeVariant = nextVariants.find((variant) => variant.id === activeId) || nextVariants[0];
  const writingEntries = activeVariant?.entries || entriesForIds(writingLeafIds);
  const existingNoteIds = [...new Set([
    ...(navigator.noteBoardIds || []),
    ...(navigator.noteEntries ? flatten(navigator.noteEntries) : []),
    ...noteLeafIds,
  ])];
  const noteEntries = navigator.noteEntries?.length
    ? [...navigator.noteEntries]
    : entriesForIds(existingNoteIds);
  const noteIds = new Set(flatten(noteEntries));
  for (const id of existingNoteIds) {
    if (!noteIds.has(id)) {
      noteEntries.push({ type: "board", id });
      noteIds.add(id);
    }
  }
  const recoveredIds: string[] = [];
  const allRegistered = new Set([
    ...nextVariants.flatMap((variant) => flatten(variant.entries)),
    ...noteIds,
  ]);
  // Any saved, open text payload that has no pane or Navigator reference in an
  // incomplete legacy file is retained as a Notes board instead of orphaned.
  for (const id of Object.keys(openText || {})) {
    if (hasRecoverableText(openText[id]) && !allRegistered.has(id) && !writingLeafIds.includes(id) && !noteIds.has(id)) {
      noteEntries.push({ type: "board", id });
      noteIds.add(id);
      recoveredIds.push(id);
    }
  }
  const boardNames = { ...(navigator.boardNames || {}) };
  const usedNames = new Set(Object.values(boardNames));
  let recoveredNumber = 1;
  for (const id of recoveredIds) {
    if (boardNames[id]) continue;
    let name = recoveredNumber === 1 ? "Recovered Document" : `Recovered Document ${String(recoveredNumber).padStart(2, "0")}`;
    while (usedNames.has(name)) {
      recoveredNumber += 1;
      name = `Recovered Document ${String(recoveredNumber).padStart(2, "0")}`;
    }
    boardNames[id] = name;
    usedNames.add(name);
    recoveredNumber += 1;
  }

  const update = (node: SwonTree): SwonTree => {
    if (node.type === "leaf") {
      if (node.id !== navigator.id) return node;
      return {
        ...node,
        writingVariants: nextVariants,
        activeWritingVariantId: activeId,
        writingEntries,
        writingBoardIds: flatten(writingEntries),
        noteEntries,
        noteBoardIds: flatten(noteEntries),
        boardNames,
        mainBoardId: node.mainBoardId || writingLeafIds[0],
        mainPaneLeafId: node.mainPaneLeafId || writingLeaves[0]?.id,
      };
    }
    return { ...node, a: update(node.a), b: update(node.b) };
  };
  return update(tree);
}

/** Host hooks for reading/writing app state. */
type Opts = {
  getTree: () => SwonTree;
  setTree: (t: SwonTree) => void;

  getOpenText: () => Record<string, string>;
  setOpenText: (m: Record<string, string>) => void;

  getArchivedText: () => Record<string, string>;
  setArchivedText: (m: Record<string, string>) => void;

  getImages: () => Record<string, SwonImage>;
  setImages: (m: Record<string, SwonImage>) => void;

  getPrefs: () => any;
  setPrefs: (p: any) => void;

  getWindowState?: () => SwonWindowState | undefined;
  setWindowState?: (state: SwonWindowState) => void;

  getEchoBg: () => string | null;

  makeFreshTree?: () => SwonTree;
  bumpSession?: () => void;

  notify: NotifyFn;
};

/** Public I/O surface used by UI. */
export type SwonIO = {
  markDirty(): void;
  clearDirty(): void;
  isDirty(): boolean;
  canQuickSave(): boolean;
  save(options?: { createBackup?: boolean; autoSave?: boolean }): Promise<void | string | null>;
  saveAs(): Promise<void | string | null>;
  open(): Promise<void | string | null>;
  openAt(absPath: string): Promise<void | string | null>; // helper for e.g. sidebar double-click
  newFile(): void;
  getTitle(): string;
  notify: NotifyFn;
};

// workingFolder / autosave / theme 같은 전역 설정은
// 프로젝트 파일(swon)에는 절대 저장하지 않는다.
function stripNonProjectPrefs(p: any): any {
  if (!p || typeof p !== "object") return {};
  const rest: any = { ...(p as any) };

  // 1) workingFolder 제거
  delete rest.workingFolder;

  // 2) autosave / theme / locale 계열 키 제거
  for (const key of Object.keys(rest)) {
    const lower = key.toLowerCase();

    if (lower.startsWith("theme")) {
      delete rest[key];
      continue;
    }
    if (lower.includes("autosave")) {
      delete rest[key];
      continue;
    }

    // ✅ 국가/입력 관련 전역값은 프로젝트에 저장하지 않기
    if (lower === "language" || lower === "inputlocale" || lower.endsWith("locale")) {
      delete rest[key];
      continue;
    }
  }

  return rest;
}

// swon 에서 prefs 를 불러올 때도 workingFolder / autosave / theme 는
// 항상 “현재 앱 설정”을 유지한다.
function mergePrefsKeepingGlobals(current: any, incoming: any): any {
  const base = current && typeof current === "object" ? current : {};
  const src = incoming && typeof incoming === "object" ? incoming : {};

  // incoming 쪽에서 전역 설정(workingFolder / autosave / theme)만 제거
  const srcClean = stripNonProjectPrefs(src);

  // base 위에 “문서 스타일용 prefs”만 덮어씌우기
  // → accentColor / typeface / writingGoal / curlyBraces 같은 것들은
  //    swon 쪽 값으로 바뀌고,
  //   workingFolder / autosave / theme 는 base 값 유지.
  const merged: any = { ...base, ...srcClean };
  return merged;
}

export function setupSwonIO(opts: Opts): SwonIO {
  // `dirty` tracks edits since the last manual save and is used for Ctrl+S backups.
  let dirty = false;
  // Autosave and unsaved-change guards use their own state so autosave can clear
  // its pending write without consuming the manual-save dirty flag.
  let autosaveDirty = false;
  // Keep the last manual-save version in memory because autosave overwrites disk.
  let manualSaveSnapshot: string | null = null;
  let fileHandle: any | null = null; // Web: File System Access API handle
  let diskPath: string | null = null; // Tauri: absolute path chosen by the user
  let fileName: string | null = null; // Title hint only

  const markDirty = () => {
    dirty = true;
    autosaveDirty = true;
    bumpTitle(true);
  };
  const clearDirty = () => {
    dirty = false;
    autosaveDirty = false;
    bumpTitle(false);
  };
  const clearAutosaveDirty = () => {
    autosaveDirty = false;
    bumpTitle(false);
  };
  const isDirty = () => autosaveDirty;

  /** Update window title with an asterisk when there are unsaved edits. */
  const bumpTitle = (d = autosaveDirty) => {
    try {
      const base = fileName || "untitled";
      document.title = `${base}${d ? " *" : ""} — Splitwriter`;
    } catch {}
  };

  /** Whether Ctrl+S can write immediately without asking for a path. */
  const canQuickSave = () =>
    !!(fileHandle && typeof (fileHandle as any).createWritable === "function") ||
    (!!diskPath && !!(window as any).__TAURI_IPC__);

  /**
   * Expose current project path for other modules (e.g. MainUI duplicate-to-subfolder).
   * - __SW_CURRENT_FILE__ — string | null absolute path (Tauri only)
   * - __SWON_IO__         — helper with getCurrentFilePath()/canQuickSave()
   */
  function syncCurrentFileGlobals() {
    try {
      const w: any = window;
      const currentPath = diskPath || null;
      w.__SW_CURRENT_FILE__ = currentPath;
      w.__SWON_IO__ = {
        ...(w.__SWON_IO__ || {}),
        getCurrentFilePath: () => currentPath,
        canQuickSave,
      };
    } catch {
      // ignore
    }
  }

  // 초기 상태도 한 번 동기화 (새 파일 = null)
  syncCurrentFileGlobals();

  // ----------------------------- small helpers

  /** Heuristic: looks like an absolute filesystem path. */
  const isPathLike = (s?: string | null) =>
    !!s && (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("\\\\"));

  const ensureSwonExt = (p: string) => (/\.swon$/i.test(p) ? p : `${p}.swon`);

  const setFileNameFromPath = (p: string | null) => {
    if (!p) return;
    try {
      fileName = p.split(/[\\/]/).pop()?.replace(/\.swon$/i, "") || fileName || "untitled";
    } catch {
      fileName = fileName || "untitled";
    }
  };

  /** App-scoped ephemeral URL schemes. */
  const isEphemeralUrl = (s?: string | null) => !!s && /^(asset:|tauri:|app:)/i.test(s);

  /** Transient in-memory sources (clipboard paste, canvases, etc.). */
  const isBlobOrData = (s?: string | null) => !!s && /^(blob:|data:)/i.test(s);

  // ----------------------------- default/new layout

  function defaultTree(): SwonTree {
    return {
      type: "split",
      dir: "vertical",
      ratio: 0.5,
      a: { type: "leaf", id: "1", kind: "text", textId: "T2", imageId: "I3" },
      b: { type: "leaf", id: "4", kind: "image", textId: "T5", imageId: "I6" },
    };
  }
  /** Make a new tree using host override when available. */
  function freshTree(): SwonTree {
    try {
      return opts.makeFreshTree ? opts.makeFreshTree() : defaultTree();
    } catch {
      return defaultTree();
    }
  }

  // ----------------------------- build/serialize/apply

  function buildSwon(): SwonFile {
    const imgsIn = opts.getImages() || {};
    const images: Record<string, SwonImage> = {};
    for (const [id, im] of Object.entries(imgsIn)) {
      const srcNow = (im as any)?.src ?? null;
      const fileAbs = (im as any)?.file ?? null;

      let srcToSave: string | null;
      if (isBlobOrData(srcNow)) {
        srcToSave = fileAbs ?? null;
      } else if (isEphemeralUrl(srcNow)) {
        srcToSave = fileAbs ?? srcNow;
      } else if (isPathLike(srcNow)) {
        srcToSave = srcNow;
      } else {
        srcToSave = srcNow ?? fileAbs ?? null;
      }

      const fileToSave = fileAbs ?? (isPathLike(srcNow) ? srcNow : null);
      images[id] = { src: srcToSave, view: im?.view, file: fileToSave };
    }

    // prefs: workingFolder / autosave / theme 제거 후 저장
    const rawPrefs = (opts.getPrefs() || {}) as any;
    const prefsToSave = stripNonProjectPrefs(rawPrefs);

    return {
      kind: "splitwriter",
      version: 1,
      tree: opts.getTree(),
      openText: opts.getOpenText() || {},
      archivedText: opts.getArchivedText() || {},
      images,
      prefs: prefsToSave,
      window: opts.getWindowState?.(),
      echoBg: opts.getEchoBg?.() ?? null,
      savedAt: new Date().toISOString(),
      title: fileName || undefined,
    };
  }

  /** Stringify current state for disk. */
  function serialize(): string {
    return JSON.stringify(buildSwon());
  }

  /** Apply a loaded SWON snapshot to the host app. */
  function applySwon(data: SwonFile, bump = false) {
    // Normalize images so that `src` remains stable and `file` is an absolute path when possible.
    const normalized: Record<string, SwonImage> = {};
    for (const [id, im] of Object.entries(data.images || {})) {
      let raw = (im?.src ?? im?.file ?? null) as string | null;
      if (isEphemeralUrl(raw) && im?.file) raw = im.file;
      const fileFixed = im?.file ?? (isPathLike(raw) ? raw : null);
      normalized[id] = { src: raw, view: im?.view, file: fileFixed };
    }

    if (data.tree) opts.setTree(normalizeLegacyNavigator(data.tree, data.openText || {}));
    opts.setOpenText(data.openText || {});
    opts.setArchivedText(data.archivedText || {});

    if (data.prefs) {
      const currentPrefs = opts.getPrefs();
      const mergedPrefs = mergePrefsKeepingGlobals(currentPrefs, data.prefs);
      opts.setPrefs(mergedPrefs);
    }

    opts.setImages(normalized);

    const windowState = normalizeWindowState(data.window);
    if (windowState && opts.setWindowState) opts.setWindowState(windowState);

    // NOTE: data.echoBg 는 아직 적용 훅(setEchoBg)이 없어서
    //       단순히 저장만 하고 있음. 나중에 필요하면 Opts에 setEchoBg 추가해서
    //       여기서 같이 넣어주면 됨.

    clearDirty();
    if (bump) opts.bumpSession?.();
  }

  // ----------------------------- save / save as

  /** Save with an explicit path chooser. */
  async function saveAs() {
    const text = serialize();

    // Tauri
    if ((window as any).__TAURI_IPC__) {
      const { writeTextFile } = await import("@tauri-apps/api/fs");
      const { save } = await import("@tauri-apps/api/dialog");
      const picked = await save({
        defaultPath: `${fileName || "untitled"}.swon`,
        filters: [{ name: "Splitwriter Project", extensions: ["swon"] }],
      });
      if (typeof picked !== "string") return null; // canceled
      const target = ensureSwonExt(String(picked));
      await writeTextFile(target, text);
      diskPath = target; // allow Ctrl+S afterwards
      fileHandle = null;
      manualSaveSnapshot = text;
      setFileNameFromPath(target);
      clearDirty();
      syncCurrentFileGlobals();
      opts.notify(`Saved: ${fileName}.swon`, "info", 1400);
      return diskPath;
    }

    // Web: File System Access API
    const showSave = (window as any).showSaveFilePicker;
    if (showSave) {
      const handle = await showSave({
        types: [
          {
            description: "Splitwriter Project",
            accept: { "application/json": [".swon"] },
          },
        ],
        suggestedName: `${fileName || "untitled"}.swon`,
      });
      const w = await (handle as any).createWritable();
      await w.write(text);
      await w.close();
      fileHandle = handle;
      manualSaveSnapshot = text;
      fileName =
        (handle as any).name?.replace(/\.swon$/i, "") ||
        fileName ||
        "untitled";
      clearDirty();
      opts.notify(`Saved: ${fileName}.swon`, "info", 1400);
      return null;
    }

    // Web: download fallback
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName || "untitled"}.swon`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
    manualSaveSnapshot = text;
    clearDirty();
    opts.notify(
      `Saved${fileName ? `: ${fileName}.swon` : ""}`,
      "info",
      1400
    );
  }

  /** Save to the last known location if possible; otherwise fall back to Save As. */
  async function save(options: { createBackup?: boolean; autoSave?: boolean } = {}) {
    const text = serialize();
    // Every explicit/manual save shares the same backup behavior. Only the
    // autosave path opts out; callers may also explicitly disable backups.
    const createBackup = !options.autoSave && options.createBackup !== false;
    let backupStatus: "created" | "failed" | null = null;

    // Tauri
    if ((window as any).__TAURI_IPC__) {
      const { writeTextFile, exists, createDir, readDir, copyFile, removeFile } = await import("@tauri-apps/api/fs");
      const { save } = await import("@tauri-apps/api/dialog");
      if (!diskPath) {
        const picked = await save({
          defaultPath: `${fileName || "untitled"}.swon`,
          filters: [{ name: "Splitwriter Project", extensions: ["swon"] }],
        });
        if (typeof picked !== "string") return null; // canceled
        diskPath = ensureSwonExt(String(picked));
        setFileNameFromPath(diskPath);
      }
      if (createBackup && dirty && await exists(diskPath)) {
        try {
          const sep = diskPath.includes("\\") ? "\\" : "/";
          const lastSep = Math.max(diskPath.lastIndexOf("\\"), diskPath.lastIndexOf("/"));
          const parent = lastSep >= 0 ? diskPath.slice(0, lastSep) : ".";
          const originalName = diskPath.slice(lastSep + 1);
          const stem = originalName.replace(/\.swon$/i, "");
          const backupDir = `${parent}${sep}_Backups`;
          await createDir(backupDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          let backupPath = `${backupDir}${sep}${stem}.${stamp}.swon`;
          let suffix = 1;
          while (await exists(backupPath)) {
            backupPath = `${backupDir}${sep}${stem}.${stamp}-${suffix++}.swon`;
          }
          if (manualSaveSnapshot != null) await writeTextFile(backupPath, manualSaveSnapshot);
          else await copyFile(diskPath, backupPath);
          backupStatus = "created";

          const entries = await readDir(backupDir);
          const prefix = `${stem}.`;
          const backups = entries
            .filter((entry) => entry.name && entry.name.startsWith(prefix) && /\.swon$/i.test(entry.name))
            .map((entry) => entry.name!)
            .sort((a, b) => b.localeCompare(a));
          for (const oldBackup of backups.slice(10)) {
            await removeFile(`${backupDir}${sep}${oldBackup}`);
          }
        } catch (error) {
          backupStatus = "failed";
          console.error("Could not create the manual-save backup:", error);
        }
      }
      await writeTextFile(diskPath, text);
      if (!fileName || fileName === "untitled") setFileNameFromPath(diskPath);
      if (options.autoSave || (createBackup && backupStatus === "failed")) {
        // A failed backup must remain retryable even though the project itself
        // was saved successfully.
        clearAutosaveDirty();
      } else {
        manualSaveSnapshot = text;
        clearDirty();
      }
      syncCurrentFileGlobals();
      const savedLabel = `Saved${fileName ? `: ${fileName}.swon` : ""}`;
      opts.notify(
        backupStatus === "created" ? `${savedLabel} (backup created)` :
          backupStatus === "failed" ? `${savedLabel} — backup failed` : savedLabel,
        backupStatus === "failed" ? "warn" : "info",
        1800
      );
      return diskPath;
    }

    // Web: direct write via File System Access API
    if (fileHandle && (fileHandle as any).createWritable) {
      const w = await (fileHandle as any).createWritable();
      await w.write(text);
      await w.close();
      if (options.autoSave) clearAutosaveDirty();
      else {
        manualSaveSnapshot = text;
        clearDirty();
      }
      opts.notify(
        `Saved${fileName ? `: ${fileName}.swon` : ""}`,
        "info",
        1400
      );
      return;
    }

    // Web: download fallback
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName || "untitled"}.swon`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
    if (options.autoSave) clearAutosaveDirty();
    else {
      manualSaveSnapshot = text;
      clearDirty();
    }
    opts.notify(
      `Saved${fileName ? `: ${fileName}.swon` : ""}`,
      "info",
      1400
    );
  }

  // ----------------------------- open

  /** Open a project via a picker and load it into the app. */
  async function open() {
    if ((window as any).__TAURI_IPC__) {
      const { open } = await import("@tauri-apps/api/dialog");
      const { readTextFile } = await import("@tauri-apps/api/fs");
      const picked = await open({
        multiple: false,
        filters: [{ name: "Splitwriter Project", extensions: ["swon", "json"] }],
      });
      if (typeof picked !== "string") return; // canceled
      const raw = await readTextFile(picked);
      const text = raw.replace(/^\uFEFF/, "");
      const data = JSON.parse(text) as SwonFile;
      if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
      applySwon(data, /* bump */ true);
      manualSaveSnapshot = raw;
      diskPath = picked;
      fileHandle = null;
      try {
        fileName =
          picked.split(/[\\/]/).pop()?.replace(/\.swon$/i, "") ||
          data.title ||
          "untitled";
      } catch {}
      syncCurrentFileGlobals();
      opts.notify(`${fileName}.swon loaded`, "info", 1600);
      return diskPath;
    }

    // Web: File System Access API
    const showOpen = (window as any).showOpenFilePicker;
    try {
      if (showOpen) {
        const [handle] = await showOpen({
          multiple: false,
          types: [
            {
              description: "Splitwriter Project",
              accept: { "application/json": [".swon", ".json"] },
            },
          ],
        });
        const file = await handle.getFile();
        const raw = await file.text();
        const text = raw.replace(/^\uFEFF/, "");
        const data = JSON.parse(text) as SwonFile;
        if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
        applySwon(data, /* bump */ true);
        manualSaveSnapshot = raw;
        fileHandle = handle;
        fileName =
          (handle as any).name?.replace(/\.swon$/i, "") ||
          data.title ||
          "untitled";
        opts.notify(`${fileName}.swon loaded`, "info", 1600);
        return;
      }
    } catch (e) {
      console.error(e);
    }

    // Web: input fallback
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.swon,.json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const raw = await f.text();
      const text = raw.replace(/^\uFEFF/, "");
      const data = JSON.parse(text) as SwonFile;
      if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
      applySwon(data, /* bump */ true);
      manualSaveSnapshot = raw;
      fileHandle = null;
      diskPath = null;
      fileName =
        f.name?.replace(/\.swon$/i, "") || data.title || "untitled";
      opts.notify(`${fileName}.swon loaded`, "info", 1600);
    };
    inp.click();
  }

  /** Open a specific absolute path (Tauri). Falls back to `open()` on the web. */
  async function openAt(absPath: string) {
    if (!(window as any).__TAURI_IPC__) {
      return open();
    }

    const { readTextFile } = await import("@tauri-apps/api/fs");
    const raw = await readTextFile(absPath);
    const text = raw.replace(/^\uFEFF/, "");
    const data = JSON.parse(text) as SwonFile;

    if (data.kind !== "splitwriter") throw new Error("Not a SWON file");

    applySwon(data, /* bump */ true);
    manualSaveSnapshot = raw;
    diskPath = absPath;
    fileHandle = null;

    try {
      fileName =
        absPath.split(/[\\/]/).pop()?.replace(/\.swon$/i, "") ||
        data.title ||
        "untitled";
    } catch {}

    syncCurrentFileGlobals();
    opts.notify(`${fileName}.swon loaded`, "info", 1600);
    return diskPath;
  }

  // ----------------------------- new

  /** Start a fresh project using `makeFreshTree()` when provided. */
  function newFile() {
    const empty: SwonFile = {
      kind: "splitwriter",
      version: 1,
      tree: freshTree(),
      openText: {},
      archivedText: {},
      images: {},
      window: opts.getWindowState?.(),
      // prefs: project profile settings only; global folder/autosave/theme/language remain app-wide.
      prefs: stripNonProjectPrefs(opts.getPrefs() || {}),
      echoBg: null,
    };
    applySwon(empty, /* bump */ true);
    fileHandle = null;
    diskPath = null;
    fileName = "untitled";
    manualSaveSnapshot = null;
    clearDirty();
    syncCurrentFileGlobals();
    opts.notify(`New file`, "info", 1200);
  }

  const getTitle = () => fileName || "untitled";

  return {
    markDirty,
    clearDirty,
    isDirty,
    save,
    saveAs,
    open,
    openAt,
    newFile,
    getTitle,
    notify: opts.notify,
    canQuickSave,
  };
}
