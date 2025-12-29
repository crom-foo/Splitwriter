// src/windows/swon.ts
import type { ImageView } from "./boards/ImageBoard";

/**
 * SWON I/O (save/load/new) for Splitwriter.
 * Persists: (1) layout tree, (2) open/archived text, (3) image src + view,
 *           (4) per-project prefs (except workingFolder / autosave / theme),
 *           (5) echo background.
 * Supports Tauri (@tauri-apps/*) and the web (File System Access API + anchor fallback).
 */

export type SwonView = ImageView;

/** Image payload persisted in the SWON. `src` may be an absolute path or a URL. */
export type SwonImage = { src: string | null; view?: SwonView; file?: string | null };

export type NotifyLevel = "info" | "warn" | "error";
export type NotifyFn = (text: string, level?: NotifyLevel, ttlMs?: number) => void;

/** Project layout tree (split panes + leaves). */
export type SwonTree =
  | {
      type: "leaf";
      id: string;
      kind: "text" | "image" | "viewer" | "edit";
      textId: string;
      imageId: string;
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
  echoBg?: string | null;
  savedAt?: string; // ISO timestamp
  title?: string; // filename hint (without .swon) for web flows
};

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
  save(): Promise<void>;
  saveAs(): Promise<void>;
  open(): Promise<void>;
  openAt(absPath: string): Promise<void>; // helper for e.g. sidebar double-click
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

  // 2) autosave / theme 계열 키 제거
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
  }

  // NOTE: accentColor, typeface, writingGoal, curlyBraces 등은
  //       그대로 남겨서 swon 에 저장되도록 둔다.
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
  let dirty = false;
  let fileHandle: any | null = null; // Web: File System Access API handle
  let diskPath: string | null = null; // Tauri: absolute path chosen by the user
  let fileName: string | null = null; // Title hint only

  const markDirty = () => {
    dirty = true;
    bumpTitle(true);
  };
  const clearDirty = () => {
    dirty = false;
    bumpTitle(false);
  };
  const isDirty = () => dirty;

  /** Update window title with an asterisk when there are unsaved edits. */
  const bumpTitle = (d = dirty) => {
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

    if (data.tree) opts.setTree(data.tree);
    opts.setOpenText(data.openText || {});
    opts.setArchivedText(data.archivedText || {});

    if (data.prefs) {
      const currentPrefs = opts.getPrefs();
      const mergedPrefs = mergePrefsKeepingGlobals(currentPrefs, data.prefs);
      opts.setPrefs(mergedPrefs);
    }

    opts.setImages(normalized);

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
      if (typeof picked !== "string") return; // canceled
      await writeTextFile(picked, text);
      diskPath = picked; // allow Ctrl+S afterwards
      fileHandle = null;
      clearDirty();
      try {
        fileName =
          picked.split(/[\\/]/).pop()?.replace(/\.swon$/i, "") || fileName;
      } catch {}
      syncCurrentFileGlobals();
      opts.notify(`Saved: ${fileName}.swon`, "info", 1400);
      return;
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
      fileName =
        (handle as any).name?.replace(/\.swon$/i, "") ||
        fileName ||
        "untitled";
      clearDirty();
      opts.notify(`Saved: ${fileName}.swon`, "info", 1400);
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
    clearDirty();
    opts.notify(
      `Saved${fileName ? `: ${fileName}.swon` : ""}`,
      "info",
      1400
    );
  }

  /** Save to the last known location if possible; otherwise fall back to Save As. */
  async function save() {
    const text = serialize();

    // Tauri
    if ((window as any).__TAURI_IPC__) {
      const { writeTextFile } = await import("@tauri-apps/api/fs");
      const { save } = await import("@tauri-apps/api/dialog");
      if (!diskPath) {
        const picked = await save({
          defaultPath: `${fileName || "untitled"}.swon`,
          filters: [{ name: "Splitwriter Project", extensions: ["swon"] }],
        });
        if (typeof picked !== "string") return; // canceled
        diskPath = picked;
      }
      await writeTextFile(diskPath, text);
      clearDirty();
      syncCurrentFileGlobals();
      opts.notify(
        `Saved${fileName ? `: ${fileName}.swon` : ""}`,
        "info",
        1400
      );
      return;
    }

    // Web: direct write via File System Access API
    if (fileHandle && (fileHandle as any).createWritable) {
      const w = await (fileHandle as any).createWritable();
      await w.write(text);
      await w.close();
      clearDirty();
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
    clearDirty();
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
      const text = await readTextFile(picked);
      const data = JSON.parse(text) as SwonFile;
      if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
      applySwon(data, /* bump */ true);
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
      return;
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
        const text = await file.text();
        const data = JSON.parse(text) as SwonFile;
        if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
        applySwon(data, /* bump */ true);
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
      const text = await f.text();
      const data = JSON.parse(text) as SwonFile;
      if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
      applySwon(data, /* bump */ true);
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
    const text = await readTextFile(absPath);
    const data = JSON.parse(text) as SwonFile;
    if (data.kind !== "splitwriter") throw new Error("Not a SWON file");
    applySwon(data, /* bump */ true);
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
      // prefs: 현재 prefs 기준으로, 전역설정(workingFolder / autosave / theme)만 뺀 상태
      prefs: stripNonProjectPrefs(opts.getPrefs() || {}),
      echoBg: null,
    };
    applySwon(empty, /* bump */ true);
    fileHandle = null;
    diskPath = null;
    fileName = "untitled";
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
