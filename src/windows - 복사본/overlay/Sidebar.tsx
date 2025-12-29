// Sidebar.tsx — Splitwriter Sidebar (R3+ full, Win-robust rename)
// - Root folder: Create Folder
// - Sub folder:  Create Folder / New File / Rename / Delete
// - File:        Open / Rename / Delete / Details
// - Delete/Open: full-path confirm; warns when hasDirty
// - Rename: F2 or context → MiniPrompt modal; case-only rename workaround on Windows
// - New File uses writeTextFile (UTF-8)
// - Details: modal "ID — Type — Title"
/**
 * Splitwriter 사이드바(폴더 트리 뷰) 컴포넌트.
 *
 * - 작업 폴더 아래의 폴더/파일(.swon) 구조를 트리 형태로 보여준다.
 *   - 폴더: 새 폴더 / 새 파일 / 이름 변경 / 삭제
 *   - 파일: 열기 / 이름 변경 / 삭제 / Details 보기
 *
 * - 여기서는 “시각적인 트리와 UI 동작”만 책임지고,
 *   실제 파일 열기 / 저장 / Save As / 종료 같은 앱 전역 파일 액션은
 *   appActions.ts 쪽으로 위임한다.
 *   (헤더 버튼 및 파일 열기는 반드시 appSave/appSaveAs/appQuit/appOpen → appActions 경로를 탄다)
 *
 * 요약: 폴더 구조를 보여주고 유저 입력을 받아,
 *       실제 파일 처리 로직은 중앙 모듈(appActions)에게 넘기는 뷰 레이어.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@tauri-apps/api/fs";
import * as fs from "@tauri-apps/api/fs";

// Feature toggle: allow drag-to-move inside Sidebar tree
const ENABLE_DRAG_MOVE = false;

// emit helper: Tauri 이벤트(우선) → 브라우저 커스텀이벤트(폴백)
async function emitApp(name: string, detail?: any) {
  try {
    if ((window as any).__TAURI_IPC__) {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(name, detail);
    } else {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }
  } catch {}
}

/* --------------------------- appActions bridge --------------------------- */
// appActions.ts 의 존재 유무와 함수 이름 차이를 흡수하는 브릿지
async function appSave() {
  try {
    const mod: any = await import("../runtime/appActions");
    const fn = mod.saveGuarded || mod.save;
    if (typeof fn === "function") return await fn();
  } catch {}
  return emitApp("sw:save");
}
async function appSaveAs() {
  try {
    const mod: any = await import("../runtime/appActions");
    const fn = mod.saveAsGuarded || mod.saveAs;
    if (typeof fn === "function") return await fn();
  } catch {}
  return emitApp("sw:saveas");
}
async function appQuit() {
  try {
    const mod: any = await import("../runtime/appActions");
    const fn = mod.quitWithGuard || mod.quit;
    if (typeof fn === "function") return await fn();
  } catch {}
  return emitApp("sw:quit");
}

/**
 * 파일 경로를 알고 있을 때:
 *  - 우선 "경로 기반" open 함수들(openByPath/openFile/openSwon/open)을 시도하고
 *  - 없을 때만 guard 계열로 폴백한다.
 * 이렇게 해야 사이드바 더블클릭/컨텍스트 Open 시에 파일 다이얼로그가 아니라
 * 바로 해당 파일을 열 수 있다.
 */
async function appOpen(absPath: string) {
  try {
    const mod: any = await import("../runtime/appActions");

    if (absPath) {
      const pathFirst = [
        "openByPath",
        "openFile",
        "openSwon",
        "open",
        "openWithGuard",
        "openFileWithGuard",
        "openSwonWithGuard",
      ] as const;

      for (const name of pathFirst) {
        const fn = (mod as any)[name];
        if (typeof fn === "function") {
          return await fn(absPath);
        }
      }
    }
  } catch {}
  return emitApp("sw:open", { path: absPath });
}

/* ------------------------------- Icon assets ------------------------------ */
const ICONS = {
  FolderClose: new URL("../icons/Folder_Close.png", import.meta.url).href,
  FolderOpen:  new URL("../icons/Folder_Open.png",  import.meta.url).href,
  Paper:       new URL("../icons/Paper.png",        import.meta.url).href,
};
function dirOf(abs: string) {
  const m = abs.match(/^(.*)[\\/][^\\/]+$/);
  return m ? m[1] : "";
}

type SwonMeta = {
  kind: string;
  version: number | string;
  title: string;
  savedAt: string;
  counts: { openText: number; archivedText: number; images: number };
};

function summarizeSwon(obj: any): SwonMeta | null {
  if (!obj || typeof obj !== "object" || obj.kind !== "splitwriter") return null;
  const openTextCount     = obj.openText ? Object.keys(obj.openText).length : 0;
  const archivedTextCount = obj.archivedText ? Object.keys(obj.archivedText).length : 0;
  const imageCount        = obj.images ? Object.keys(obj.images).length : 0;
  return {
    kind: obj.kind,
    version: obj.version,
    title: obj.title ?? "",
    savedAt: obj.savedAt ?? "",
    counts: { openText: openTextCount, archivedText: archivedTextCount, images: imageCount },
  };
}

/* --------------------------------- Utils --------------------------------- */
function isTauri() {
  try { const w = window as any; return !!(w.__TAURI__ || w.__TAURI_INTERNALS__ || w.__TAURI_IPC__); }
  catch { return false; }
}

function joinPath(...parts: string[]) {
  const head = parts.find(p => p) || "";
  const sep = /\\/.test(head) ? "\\" : "/";
  return parts.filter(Boolean).join(sep);
}
function extLower(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
const stop = (e: any) => { e?.stopPropagation?.(); e?.preventDefault?.(); };

function normalizePath(p?: string) {
  if (!p) return "";
  return p
    .replace(/^\\\\\?\\/, "")   // Strip Windows device prefix
    .replace(/\\/g, "/")        // Normalize slashes
    .replace(/\/+$/, "")        // Trim trailing slashes
    .toLowerCase();
}
function samePath(a?: string, b?: string) {
  return !!a && !!b && normalizePath(a) === normalizePath(b);
}

// 세션 전체에서 공유하는 working-root 잠금
let lockedRootGlobal = "";
function isSubPathOf(parent: string, child: string) {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  return !!p && !!c && c.startsWith(p + "/");
}

/** 대충 윈도우 기준 절대 경로처럼 보이는지 체크 */
function looksLikeAbsolutePath(p?: string) {
  if (!p) return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/* ------------------------------- Tree types ------------------------------ */
type TreeNode =
  | { kind: "folder"; name: string; path: string; open: boolean; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

function sortTreeNodes(list: TreeNode[]) {
  const folders = list.filter(n => n.kind === "folder") as Extract<TreeNode, {kind:"folder"}>[];
  const files   = list.filter(n => n.kind === "file")   as Extract<TreeNode, {kind:"file"}>[];
  folders.sort((a,b)=>a.name.localeCompare(b.name));
  files.sort((a,b)=>a.name.localeCompare(b.name));
  return [...folders, ...files];
}
function flattenForLookup(n: TreeNode, map: Map<string, TreeNode>) {
  map.set(n.path, n);
  if (n.kind === "folder") n.children.forEach(c => flattenForLookup(c, map));
}

/* ------------------------------- FS helpers ------------------------------ */
async function scanWorkingFolder(root: string): Promise<TreeNode> {
  async function walk(abs: string): Promise<TreeNode> {
    let entries: FileEntry[] = [];
    try { entries = await fs.readDir(abs, { recursive: false }); } catch { entries = []; }
    const folders: TreeNode[] = [];
    const filesOnly: TreeNode[] = [];
    for (const e of entries) {
      if (!e.path || !e.name) continue;
      let isFolder = false;
      try { await fs.readDir(e.path, { recursive: false }); isFolder = true; } catch { isFolder = false; }
      if (isFolder) folders.push(await walk(e.path));
      else if (extLower(e.name) === "swon") filesOnly.push({ kind: "file", name: e.name, path: e.path });
    }
    return {
      kind: "folder",
      name: abs === root ? "__ROOT__" : abs.split(/[\\/]/).pop() || abs,
      path: abs,
      open: true,
      children: sortTreeNodes([...folders, ...filesOnly]),
    };
  }
  return await walk(root);
}

/* Robust rename: works for files/folders, handles Win case-only rename */
async function safeRename(oldPath: string, newPath: string) {
  if (oldPath === newPath) return;

  let isDir = false;
  try { await fs.readDir(oldPath, { recursive: false }); isDir = true; } catch { isDir = false; }

  try {
    await fs.renameFile(oldPath, newPath);
    return;
  } catch (e) {
    console.warn("renameFile failed, fallback →", { oldPath, newPath, isDir, err: e });
  }

  if (!isDir) {
    // file: copy → remove
    await fs.copyFile(oldPath, newPath);
    await fs.removeFile(oldPath);
    return;
  }

  // folder: create dst, move children, remove src
  try { await fs.createDir(newPath, { recursive: false }); } catch (_) { /* maybe exists */ }

  const entries = await fs.readDir(oldPath, { recursive: false });
  for (const ent of entries) {
    const name = ent.name!;
    const src  = joinPath(oldPath, name);
    const dst  = joinPath(newPath, name);
    try {
      await fs.renameFile(src, dst);
      continue;
    } catch (_) {
      let childIsDir = false;
      try { await fs.readDir(src, { recursive: false }); childIsDir = true; } catch { childIsDir = false; }
      if (childIsDir) {
        await safeRename(src, dst);
      } else {
        await fs.copyFile(src, dst);
        await fs.removeFile(src);
      }
    }
  }
  await fs.removeDir(oldPath);
}

/* --- Trash helper: move path to OS recycle bin via Tauri command --- */
async function trashPath(absPath: string) {
  if (!isTauri()) return;
  if (!absPath) return;

  try {
    const { invoke } = await import("@tauri-apps/api/tauri");
    // Rust 쪽에 정의할 커맨드 이름
    await invoke("sw_trash_path", { path: absPath });
  } catch (err) {
    console.error("trashPath failed", err);
    // 휴지통 이동이 실패하면 **아무 것도 지우지 않고** 에러만 올림
    throw err;
  }
}

/* -------------------------------- Component ------------------------------ */
export default function Sidebar({
  open, onClose, workingFolder, onOpenFile, onPreview,
  onSave, onSaveAs, onQuit, hasDirty, openedPath,
}: {
  open: boolean;
  onClose: () => void;
  workingFolder: string;
  onOpenFile?: (absPath: string) => void;
  onPreview?: (p: { path: string; meta: SwonMeta | null }) => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onQuit?: () => void | Promise<void>;
  hasDirty?: boolean;
  openedPath?: string;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; target: TreeNode } | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);
  // prefs 에서 온 working folder 를 세션 동안 잠궈두기
  const [lockedRoot, setLockedRoot] = useState<string>(() => lockedRootGlobal || "");

  async function previewSwon(absPath: string) {
    try {
      if (!isTauri()) { onPreview?.({ path: absPath, meta: null }); return; }
      const txt = await fs.readTextFile(absPath);
      let obj: any = null; try { obj = JSON.parse(txt); } catch {}
      onPreview?.({ path: absPath, meta: summarizeSwon(obj) });
    } catch {
      onPreview?.({ path: absPath, meta: null });
    }
  }

  // Mini prompt modal state
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptTitle, setPromptTitle] = useState("");
  const [promptInitial, setPromptInitial] = useState("");
  const promptResolveRef = useRef<((val: string | null) => void) | null>(null);

  // Details modal state
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsMeta, setDetailsMeta] =
    useState<{ file: string; meta: SwonMeta | null } | null>(null);

  // 현재 열려있는 파일(앱 전역)과 사이드바가 마지막으로 연 파일을 둘 다 기억
  const [openedLocal, setOpenedLocal] = useState<string>("");

  useEffect(() => {
    if (openedPath) setOpenedLocal(openedPath);
  }, [openedPath]);

  // workingFolder 업데이트 → 세션 전역 루트 잠금
  useEffect(() => {
    const next = (workingFolder || "").trim();
    if (!next) return;

    setLockedRoot(prev => {
      const prevEff = prev || lockedRootGlobal || "";
      // 아직 아무 루트도 없으면 지금 값을 루트로 채택
      if (!prevEff) {
        lockedRootGlobal = next;
        return next;
      }

      // 기존 루트의 "하위 폴더"로 줄어드는 변화면
      // 파일 열기 부작용으로 보고 무시
      if (isSubPathOf(prevEff, next)) {
        return prevEff;
      }

      // 완전히 다른 경로(D: 드라이브 등)면 prefs 변경으로 보고 갱신
      lockedRootGlobal = next;
      return next;
    });
  }, [workingFolder]);

  // Sidebar 가 실제로 사용하는 루트 경로
  const effectiveRoot = useMemo(() => {
    if (lockedRoot) return lockedRoot;
    if (lockedRootGlobal) return lockedRootGlobal;
    return (workingFolder || "").trim();
  }, [lockedRoot, workingFolder]);

  const lookup = useMemo(() => {
    const m = new Map<string, TreeNode>();
    if (root) flattenForLookup(root, m);
    return m;
  }, [root]);

  /**
   * currentOpenPath:
   *  - openedPath 가 절대경로면 그대로 사용
   *  - 파일명만 들어온 경우엔 트리에서 name 이 같은 파일을 찾아서 그 path 를 사용
   *    → Ctrl+O 로 연 파일도 사이드바에서 accent 하이라이트 가능
   */
  const currentOpenPath = useMemo(() => {
    const raw = openedPath || openedLocal || "";
    if (!raw) return "";

    // 트리가 아직 없으면 일단 그대로 반환
    if (!root) return raw;

    // 이미 정확한 path 키면 그대로
    if (lookup.has(raw)) return raw;

    // 절대 경로나 슬래시가 섞여 있으면 더 이상 이름 매칭은 안 한다
    if (looksLikeAbsolutePath(raw) || /[\\/]/.test(raw)) return raw;

    // 파일명만 온 경우: 같은 이름의 파일 노드를 찾아서 그 path 사용
    for (const node of lookup.values()) {
      if (node.kind === "file" && node.name === raw) {
        return node.path;
      }
    }
    return raw;
  }, [openedPath, openedLocal, root, lookup]);

  // Sidebar 가 열릴 때, 전역 현재 파일(window.__SW_CURRENT_FILE__)도 한 번 동기화
  useEffect(() => {
    if (!open) return;
    try {
      const cur = (window as any).__SW_CURRENT_FILE__;
      if (typeof cur === "string" && cur) {
        setOpenedLocal(cur);
      }
    } catch {
      // ignore
    }
  }, [open]);

  const openAndRemember = async (abs: string) => {
    if (openedPath && samePath(openedPath, abs)) return;
    setOpenedLocal(abs);
    if (onOpenFile) {
      onOpenFile(abs);
      return;
    }
    await appOpen(abs);
  };

  useEffect(() => {
    if (!open || !effectiveRoot || !isTauri()) return;
    (async () => {
      setLoading(true);
      try { setRoot(await scanWorkingFolder(effectiveRoot)); }
      finally { setLoading(false); }
    })();
  }, [open, effectiveRoot]);

  const refresh = async () => {
    if (!isTauri() || !effectiveRoot) return;
    setLoading(true);
    try { setRoot(await scanWorkingFolder(effectiveRoot)); }
    finally { setLoading(false); }
  };

  // Header actions → 우선 부모 콜백, 없으면 appActions → 이벤트 발행
  const handleSave   = () => { onSave   ? onSave()   : appSave(); };
  const handleSaveAs = () => { onSaveAs ? onSaveAs() : appSaveAs(); };
  const handleQuit   = () => { onQuit   ? (onQuit() as any) : appQuit(); };

  /* ----------------------- Keyboard: F2 handler (modal) ---------------------- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      const isInputLike = tag === "input" || tag === "textarea" || (target?.isContentEditable ?? false);

      if ((e.key === "F2" || (e as any).keyCode === 113) && !isInputLike) {
        if (selPath) { e.preventDefault(); beginRename(selPath); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selPath]);

  useEffect(() => {
    if (!ctx) return;

    const close = () => setCtx(null);

    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (!ctxRef.current) return close();
      if (!t || !ctxRef.current.contains(t)) close();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };

    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("wheel", onDown, true);
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("wheel", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctx]);

  /* --------------------------- Context menu helpers -------------------------- */
  function openContextMenu(e: React.MouseEvent, target: TreeNode) {
    e.preventDefault();
    setSelPath(target.path);
    setCtx({ x: e.clientX, y: e.clientY, target });
  }

  async function openMiniPrompt(title: string, initial = ""): Promise<string | null> {
    setPromptTitle(title);
    setPromptInitial(initial);
    setPromptOpen(true);
    return new Promise(res => { promptResolveRef.current = res; });
  }
  function closeMiniPrompt(val: string | null) {
    setPromptOpen(false);
    const fn = promptResolveRef.current; promptResolveRef.current = null;
    fn?.(val);
  }

  /* --------------------------------- Actions -------------------------------- */
  async function newFolder(basePath: string) {
    if (!isTauri()) return;
    const name = await openMiniPrompt("Create Folder", "");
    if (!name) return;
    try {
      await fs.createDir(joinPath(basePath, name), { recursive: false });
      await refresh();
    } catch (err) {
      alert(`Failed to create folder:\n${joinPath(basePath, name)}`);
      console.error(err);
    }
  }

  async function newFile(basePath: string) {
    if (!isTauri()) return;
    let name = await openMiniPrompt("New File (.swon)", "Untitled.swon");
    if (!name) return;
    name = name.trim();
    if (!name.toLowerCase().endsWith(".swon")) name += ".swon";
    const abs = joinPath(basePath, name);
    try {
      const exists = await fs.exists(abs);
      if (exists) { alert(`File already exists:\n${abs}`); return; }
      const swon = {
        kind: "splitwriter",
        version: 1,
        tree: {
          type: "split", dir: "vertical", ratio: 0.5,
          a: { type: "leaf", id: "1", kind: "text",  textId: "T2", imageId: "I3" },
          b: { type: "leaf", id: "4", kind: "image", textId: "T5", imageId: "I6" },
        },
        openText: {},
        archivedText: {},
        images: {},
        prefs: {},
        echoBg: null,
        savedAt: new Date().toISOString(),
        title: name.replace(/\.swon$/i, ""),
      };
      await fs.writeTextFile(abs, JSON.stringify(swon, null, 2) + "\n");
      await refresh();
    } catch (err) {
      alert(`Failed to create SWON file:\n${abs}`);
      console.error(err);
    }
  }

  // 파일 삭제: 더티 상태와 무관, 휴지통으로 이동
  async function deleteFile(absPath: string) {
    if (!isTauri()) return;

    // 1) 먼저 확인 창을 띄우고
    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/api/dialog");
      ok = await confirm(
        `Delete this file?\n${absPath}\n\n(The file will be moved to the system Recycle Bin.)`,
        {
          title: "Splitwriter",
          type: "warning",
        }
      );
    } catch (err) {
      console.error("Delete confirm failed:", err);
      return; // 다이얼로그 실패하면 그냥 삭제 안 함
    }

    if (!ok) return; // Cancel 누르면 바로 종료

    // 2) 확인한 뒤에만 휴지통으로 이동
    try {
      const { invoke } = await import("@tauri-apps/api/tauri");
      await invoke("sw_trash_path", { path: absPath });
      await refresh();
    } catch (err) {
      alert(`Failed to delete:\n${absPath}`);
      console.error(err);
    }
  }

  // 폴더 삭제: 지금은 폴더도 휴지통으로 (원하면 나중에 다시 제한 걸 수 있음)
  async function deleteFolder(absPath: string) {
    if (!isTauri()) return;

    // 1) 먼저 폴더가 비어 있는지 확인
    try {
      const entries = await fs.readDir(absPath, { recursive: false });
      if (entries.length > 0) {
        const { message } = await import("@tauri-apps/api/dialog");
        await message(
          "This folder is not empty.\nYou can only delete empty folders from the Project sidebar.",
          { title: "Splitwriter", type: "warning" }
        );
        return;
      }
    } catch (err) {
      alert(`Failed to read folder:\n${absPath}`);
      console.error(err);
      return;
    }

    // 2) OS confirm 다이얼로그로 먼저 확인
    const prompt =
      `Delete this folder? (must be empty)\n${absPath}\n\n` +
      "(The folder will be moved to the system Recycle Bin.)";

    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/api/dialog");
      ok = await confirm(prompt, { title: "Splitwriter", type: "info" });
    } catch {
      // 브라우저 프리뷰 모드 등에서의 폴백
      ok = window.confirm(prompt);
    }
    if (!ok) return;

    // 3) 실제 삭제는 Rust 쪽 trash 커맨드로 → 휴지통으로 이동
    try {
      const { invoke } = await import("@tauri-apps/api/tauri");
      await invoke("sw_trash_path", { path: absPath });
      await refresh();
    } catch (err) {
      alert(`Failed to delete folder:\n${absPath}`);
      console.error(err);
    }
  }

  async function beginRename(absPath: string) {
    if (!isTauri()) return;
    const oldName = absPath.split(/[\\/]/).pop() || "item";
    const input = await openMiniPrompt("Rename", oldName);
    if (!input || input === oldName) return;

    // sanitize & Windows case-only workaround
    const cleaned = input.trim().replace(/[\\/:*?"<>|]/g, "_");
    try {
      const base = dirOf(absPath);
      const sameExceptCase = oldName.toLowerCase() === cleaned.toLowerCase() && oldName !== cleaned;
      const next = joinPath(base, cleaned);

      if (sameExceptCase) {
        const temp = joinPath(base, `.__renametmp__${Date.now()}`);
        await safeRename(absPath, temp);
        await safeRename(temp, next);
      } else {
        await safeRename(absPath, next);
      }

      if (selPath === absPath) setSelPath(next);
      await refresh();
    } catch (err) {
      alert("Rename failed.");
      console.error(err);
    }
  }

  function startDrag(e: React.DragEvent, node: TreeNode) {
    e.dataTransfer.setData("text/plain", node.path);
    try { e.dataTransfer.setData("application/x-path", node.path); } catch {}
    e.dataTransfer.effectAllowed = "move";
  }
  function allowDropOnFolder(e: React.DragEvent, node: TreeNode) {
    if (node.kind !== "folder") return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
  }
  async function dropOnFolder(e: React.DragEvent, folder: TreeNode) {
    if (folder.kind !== "folder") return;
    e.preventDefault();
    const filePath = e.dataTransfer.getData("text/plain"); if (!filePath) return;
    const name = filePath.split(/[\\/]/).pop()!;
    const dst  = joinPath(folder.path, name);

     if (dst === filePath) return;

     // 2) Prevent moving a folder into its own subtree
     const norm = (p:string) => p.replace(/\\/g, "/");
     const srcN = norm(filePath), dstN = norm(dst);
     if (srcN.endsWith(name) && dstN.startsWith(srcN + "/")) {
       alert("Cannot move a folder into itself.");
       return;
    }

     // 3) Abort if destination already exists
     try {
       if (await fs.exists(dst)) { alert(`Already exists:\n${dst}`); return; }
    } catch {}

    try { await safeRename(filePath, dst); await refresh(); }

    catch (err) { alert("Move failed."); console.error(err); }
  }

  /* --------------------------------- Details -------------------------------- */
  async function showDetails(absPath: string) {
    if (!isTauri()) return;
    try {
      const txt = await fs.readTextFile(absPath);
      let obj: any = null; try { obj = JSON.parse(txt); } catch { obj = null; }
      const meta = summarizeSwon(obj);
      setDetailsMeta({ file: absPath, meta });
      setDetailsOpen(true);
    } catch (err) {
      alert("Failed to read file.");
      console.error(err);
    }
  }

  /* ---------------------------------- View ---------------------------------- */
  return (
    <>
      {/* panel */}
      <div
        className={`fixed inset-y-0 left-0 z-[9998] transition-transform duration-500 ${open ? "translate-x-0" : "-translate-x-full"}`}
        onMouseDown={(e)=>e.stopPropagation()} onPointerDown={(e)=>e.stopPropagation()}
      >
        <div className="h-full w-[330px] bg-[var(--sb-bg)] text-[var(--sb-text)] border-r border-[var(--sb-border)] flex flex-col backdrop-blur-lg">
          {/* header */}
          <div className="px-3 pt-3 pb-2 border-b border-[var(--sb-border)]">
            <div className="text-xs uppercase tracking-wide opacity-70">Project</div>
            <div className="mt-1 text-[13px] leading-snug break-all">
              {effectiveRoot || "(no folder set)"}
              {hasDirty ? <span title="Unsaved changes" className="ml-2 inline-block w-2 h-2 rounded-full bg-[var(--sb-dirty-dot)]" /> : null}
            </div>
            <div className="mt-2 flex gap-2">
              <button className="px-2.5 py-1 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] text-sm"
                      onClick={handleSave} title="Save (Ctrl+S)">Save</button>
              <button className="px-2.5 py-1 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] text-sm"
                      onClick={handleSaveAs} title="Save As (Ctrl+Shift+S)">Save&nbsp;As</button>
              <button className="ml-auto px-2.5 py-1 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] text-sm"
                      onClick={handleQuit} title="Quit (confirm if unsaved)">Quit</button>
            </div>
          </div>

          {/* body */}
          <div className="flex-1 overflow-auto" tabIndex={-1} onFocus={(e)=> (e.currentTarget as HTMLElement).blur()}>
            {!isTauri() && <div className="m-2 text-xs opacity-70">(Preview) Browser mode — file actions disabled.</div>}
            {loading && <div className="m-2 text-sm">Loading…</div>}
            {!loading && root && (
              <TreeView
                node={root} depth={0} selected={selPath}
                enableDragMove={ENABLE_DRAG_MOVE}
                onSelect={p=>{
                  setSelPath(p);
                  const n = lookup.get(p);
                  if (n?.kind === "file") previewSwon(p); 
                }}
                onOpenFile={openAndRemember}
                onToggleOpen={p=>{ const n=lookup.get(p); if(n&&n.kind==="folder"){ n.open=!n.open; setRoot({...root}); } }}
                onContextMenu={openContextMenu}
                onStartDrag={startDrag}
                onDragOverFolder={allowDropOnFolder} onDropOnFolder={dropOnFolder}
                onRequestRename={(abs)=>beginRename(abs)}
                onRequestDetails={(abs)=>showDetails(abs)}
                currentOpen={currentOpenPath}
              />
            )}
          </div>

          {/* footer */}
          <div className="px-3 py-2 border-t border-[var(--sb-border)] text-xs opacity-70">
            SWON only · right-click / F2 to rename
          </div>
        </div>
      </div>

      {/* backdrop */}
      {open && <div className="fixed inset-0 z-[9997] bg-[var(--sb-backdrop)]" onClick={onClose} onContextMenu={(e)=>{e.preventDefault(); onClose();}} />}

      {/* context menu */}
      {ctx && (
        <div
          ref={ctxRef} 
          className="fixed z-[9999] min-w-[220px] bg-[var(--sb-menu-bg)] text-[var(--sb-text)] rounded-lg p-1 border border-[var(--sb-border)] shadow-lg"
          style={{ left: ctx.x + "px", top: ctx.y + "px" }}
          onMouseDown={stop}
          onPointerDown={stop}
          onContextMenu={stop}  
        >
          {ctx.target.kind === "folder" ? (
            <>
              {root && ctx.target.path === root.path ? (
                <CtxBtn onClick={()=>{setCtx(null); newFolder(ctx.target.path);}}>Create Folder</CtxBtn>
              ) : (
                <>
                  <CtxBtn onClick={()=>{setCtx(null); newFolder(ctx.target.path);}}>Create Folder</CtxBtn>
                  <CtxBtn onClick={()=>{setCtx(null); newFile(ctx.target.path);}}>New File</CtxBtn>
                  <CtxBtn onClick={()=>{setCtx(null); beginRename(ctx.target.path);}}>Rename</CtxBtn>
                  <CtxBtn onClick={()=>{setCtx(null); deleteFolder(ctx.target.path);}}>Delete</CtxBtn>
                </>
              )}
            </>
          ) : (
            <>
              <CtxBtn onClick={()=>{ setCtx(null); openAndRemember(ctx.target.path); }}>Open</CtxBtn>
              <CtxBtn onClick={()=>{ setCtx(null); beginRename(ctx.target.path); }}>Rename</CtxBtn>
              <CtxBtn onClick={()=>{ setCtx(null); deleteFile(ctx.target.path); }}>Delete</CtxBtn>
              <CtxBtn onClick={()=>{ setCtx(null); showDetails(ctx.target.path); }}>Details</CtxBtn>
            </>
          )}
        </div>
      )}

      {/* MiniPrompt modal */}
      {promptOpen && (
        <MiniPrompt
          title={promptTitle}
          initial={promptInitial}
          onOK={(v)=>closeMiniPrompt(v)}
          onCancel={()=>closeMiniPrompt(null)}
        />
      )}

      {/* Details modal */}
      {detailsOpen && detailsMeta && (
        <DetailsModal
          file={detailsMeta.file}
          meta={detailsMeta.meta}
          onOpen={() => { openAndRemember(detailsMeta.file); }} 
          onClose={()=>setDetailsOpen(false)}
        />
      )}
    </>
  );
}

/* ------------------------------ TreeView --------------------------------- */
function TreeView(props: {
  node: TreeNode; depth: number; selected: string | null;
  enableDragMove: boolean;
  onSelect: (p: string)=>void; onOpenFile: (p:string)=>void; onToggleOpen:(p:string)=>void;
  onContextMenu:(e:React.MouseEvent, t:TreeNode)=>void; onStartDrag:(e:React.DragEvent, n:TreeNode)=>void;
  onDragOverFolder:(e:React.DragEvent, n:TreeNode)=>void; onDropOnFolder:(e:React.DragEvent, n:TreeNode)=>void;
  onRequestRename:(abs:string)=>void; onRequestDetails:(abs:string)=>void;
  currentOpen: string;
}) {
  const { node, depth, selected } = props;

  const Icon = ({
    src,
    alt,
    className = "",
    tint = false,
  }: {
    src: string;
    alt?: string;
    className?: string;
    tint?: boolean;
  }) => {
    if (tint) {
      // Use PNG alpha as mask; fill with --accent
      return (
        <span
          className={`inline-block w-4 h-4 ${className}`}
          style={{
            background: "var(--accent)",
            WebkitMask: `url(${src}) center/contain no-repeat`,
            mask: `url(${src}) center/contain no-repeat`,
            display: "inline-block",
          }}
          aria-label={alt || ""}
        />
      );
    }
    return (
      <span className={`w-4 h-4 inline-flex items-center justify-center ${className}`}>
        <img
          src={src}
          alt={alt || ""}
          width={16}
          height={16}
          draggable={false}
          style={{ display: "block" }}
        />
      </span>
    );
  };

  if (node.kind === "folder") {
    const isRoot = depth === 0 && node.name === "__ROOT__";
    const shown  = isRoot ? node.path : node.name;
    const showOpenIcon = node.open && node.children.length > 0;
    const iconSrc = showOpenIcon ? ICONS.FolderOpen : ICONS.FolderClose;
    const isSel = selected === node.path;

    return (
      <div>
        <div
          className={`group flex items-center gap-2 px-2 py-1.5 cursor-default select-none ${isSel ? "bg-[var(--sb-selected)]" : (isRoot ? "bg-[var(--sb-root-row)]" : "hover:bg-[var(--sb-hover)]")}`}
          onClick={(e)=>{ props.onSelect(node.path); props.onToggleOpen(node.path); stop(e); }}
          onContextMenu={(e)=>{ props.onSelect(node.path); props.onContextMenu(e,node); }}
          onDragOver={props.enableDragMove ? (e)=>props.onDragOverFolder(e,node) : undefined}
          onDrop={props.enableDragMove ? (e)=>props.onDropOnFolder(e,node) : undefined}
          draggable={props.enableDragMove && !isRoot}
          onDragStart={props.enableDragMove ? (e)=> props.onStartDrag(e, node) : undefined}
          title={shown}
        >
          <Icon src={iconSrc} className={showOpenIcon ? "opacity-80" : "opacity-70"} />
          <span className="text-sm truncate">{shown}</span>
        </div>
        {node.open && (
          <div className="ml-4 border-l border-[var(--sb-border)]">
            {node.children.map(c => (
              <TreeView key={c.path} {...props} node={c} depth={depth+1}/>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSel = selected === node.path;
  const isOpenNow = samePath(node.path, props.currentOpen);

  return (
    <div
      className={
        "group flex items-center gap-2 px-2 py-1.5 cursor-default select-none " +
        (isSel
          ? "bg-[var(--sb-selected)]"
          : isOpenNow
            ? "bg-[color-mix(in srgb, var(--accent) 14%, transparent)]"
            : "hover:bg-[var(--sb-hover)]")
      }
      onClick={(e)=>{ props.onSelect(node.path); stop(e); }}
      onDoubleClick={(e)=>{ props.onOpenFile?.(node.path); stop(e); }}
      onContextMenu={(e)=>{ props.onSelect(node.path); props.onContextMenu(e,node); }}
      draggable={props.enableDragMove}
      onDragStart={props.enableDragMove ? (e)=>props.onStartDrag(e,node) : undefined}
      title={node.name}
    >
      <Icon src={ICONS.Paper} className="opacity-80" tint={isOpenNow} />
      <span
        className="flex-1 text-left text-sm truncate"
        style={isOpenNow ? { color: "var(--accent)" } : undefined}
      >
        {node.name}
      </span>
    </div>
  );
}

/* ---------------------------- MiniPrompt Modal ---------------------------- */
function MiniPrompt({
  title, initial, onOK, onCancel,
}: { title: string; initial?: string; onOK: (val: string) => void; onCancel: ()=>void; }) {
  const [val, setVal] = useState(initial ?? "");
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement|null>(null);

  useEffect(()=>{ inputRef.current?.focus(); inputRef.current?.select(); },[]);

  const commit = () => { const v = val.trim(); if (v) onOK(v); };
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || (e as any).keyCode === 13) && !composing) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  return (
    <>
      <div className="fixed inset-0 z-[10000] bg-[var(--sb-backdrop)]" onClick={onCancel}/>
      <div className="fixed z-[10001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                      w-[420px] max-w-[90vw] rounded-xl border border-[var(--sb-border)]
                      bg-[var(--sb-menu-bg)] p-4 shadow-2xl">
        <div className="text-sm font-medium mb-2">{title}</div>
        <input
          ref={inputRef}
          className="w-full px-3 py-2 rounded-lg bg-[var(--sb-bg)] border border-[var(--sb-border)]
                     focus:outline-none focus:border-[var(--sb-border-strong)]"
          value={val}
          onChange={(e)=>setVal(e.target.value)}
          onKeyDown={handleKey}
          onCompositionStart={()=>setComposing(true)}
          onCompositionEnd={()=>setComposing(false)}
          enterKeyHint="done"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)]"
                  onClick={onCancel}>Cancel</button>
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)]"
                  onClick={commit}>OK</button>
        </div>
      </div>
    </>
  );
}

/* ----------------------------- Details Modal ------------------------------ */
function DetailsModal({ file, meta, onOpen, onClose }:{
  file: string;
  meta: SwonMeta | null;
  onOpen: ()=>void;
  onClose: ()=>void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[10000] bg-[var(--sb-backdrop)]" onClick={onClose}/>
      <div className="fixed z-[10001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                      w-[520px] max-w-[95vw] rounded-xl border border-[var(--sb-border)]
                      bg-[var(--sb-menu-bg)] p-4 shadow-2xl">
        <div className="text-sm font-medium mb-2">Details</div>
        <div className="text-xs opacity-80 break-all mb-3">{file}</div>
        {!meta ? (
          <div className="text-sm opacity-80">Not a SWON file.</div>
        ) : (
          <div className="space-y-2 text-sm">
            <div><b>Kind</b> — {meta.kind}</div>
            <div><b>Version</b> — {String(meta.version ?? "—")}</div>
            <div><b>Title</b> — {meta.title || "—"}</div>
            <div><b>Saved At</b> — {meta.savedAt || "—"}</div>
            <div className="mt-2">
              <b>Counts</b>
              <div className="mt-1 grid grid-cols-3 gap-2">
                <div className="px-2 py-1 rounded bg-[var(--sb-root-row)]">OpenText: {meta.counts.openText}</div>
                <div className="px-2 py-1 rounded bg-[var(--sb-root-row)]">Archived: {meta.counts.archivedText}</div>
                <div className="px-2 py-1 rounded bg-[var(--sb-root-row)]">Images: {meta.counts.images}</div>
              </div>
            </div>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)]" onClick={onClose}>Close</button>
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)]" onClick={onOpen}>Open</button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------ Ctx button -------------------------------- */
function CtxBtn({ children, onClick }: { children: React.ReactNode; onClick:()=>void; }) {
  return <button className="w-full text-left px-3 py-1.5 rounded hover:bg-[var(--sb-hover)]" onClick={onClick}>{children}</button>;
}
