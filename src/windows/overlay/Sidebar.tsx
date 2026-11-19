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
import { createPortal } from "react-dom";
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
async function appNew() {
  try {
    const mod: any = await import("../runtime/appActions");
    const fn = mod.newWithGuard || mod.newFile;
    if (typeof fn === "function") return await fn();
  } catch {}
  return emitApp("sw:new");
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

/* ----------------------------- Simple glyphs ----------------------------- */
function FolderGlyph({ open = false, className = "" }: { open?: boolean; className?: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {open ? (
      <>
        <path d="M1.8 4.1V3.7c0-.55.45-1 1-1h3.1l1.35 1.45h5.95c.55 0 1 .45 1 1v.95" stroke="currentColor" strokeWidth=".95" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m2.05 6.05 11.85-.85-1.1 5.7c-.1.5-.5.85-1 .85H3.05c-.65 0-1.08-.54-.96-1.17l.8-4.53c.1-.55.5-.95 1.05-.99Z" stroke="currentColor" strokeWidth=".95" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ) : (
      <path d="M1.8 4.1c0-.55.45-1 1-1h3.1l1.35 1.45h5.95c.55 0 1 .45 1 1v5.45c0 .55-.45 1-1 1H2.8c-.55 0-1-.45-1-1V4.1Z" stroke="currentColor" strokeWidth=".95" strokeLinecap="round" strokeLinejoin="round" />
    )}
  </svg>;
}

function FileGlyph({ className = "" }: { className?: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.1 1.75h6l3.7 3.7v8.8H3.1V1.75Z" stroke="currentColor" strokeWidth=".9" strokeLinejoin="round" />
    <path d="M9 1.9v3.7h3.55M5 8.1h5.9M5 10.35h5.9" stroke="currentColor" strokeWidth=".8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
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
async function scanWorkingFolder(root: string, previous?: TreeNode | null): Promise<TreeNode> {
  const previousFolders = new Map<string, boolean>();
  if (previous) {
    const collectOpen = (node: TreeNode) => {
      if (node.kind !== "folder") return;
      previousFolders.set(node.path, node.open);
      node.children.forEach(collectOpen);
    };
    collectOpen(previous);
  }

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
      open: abs === root ? true : previousFolders.get(abs) ?? false,
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

/* -------------------------------- Component ------------------------------ */
export default function Sidebar({
  open, onClose, workingFolder, onOpenFile, onPreview,
  onNew, onSave, onSaveAs, onArchive, onQuit, hasDirty, openedPath,
}: {
  open: boolean;
  onClose: () => void;
  workingFolder: string;
  onOpenFile?: (absPath: string) => void;
  onPreview?: (p: { path: string; meta: SwonMeta | null }) => void;
  onNew?: () => void | Promise<void>;
  onSave?: () => void;
  onSaveAs?: () => void;
  onArchive?: () => void;
  onQuit?: () => void | Promise<void>;
  hasDirty?: boolean;
  openedPath?: string;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; target: TreeNode } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "file" | "folder"; path: string; name: string } | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
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
      try { setRoot(await scanWorkingFolder(effectiveRoot, root)); }
      finally { setLoading(false); }
    })();
  }, [open, effectiveRoot]);

  const refresh = async () => {
    if (!isTauri() || !effectiveRoot) return;
    setLoading(true);
    try { setRoot(await scanWorkingFolder(effectiveRoot, root)); }
    finally { setLoading(false); }
  };

  // Header actions → 우선 부모 콜백, 없으면 appActions → 이벤트 발행
  const handleNew    = () => { onNew    ? onNew()    : appNew(); };
  const handleSave   = () => { onSave   ? onSave()   : appSave(); };
  const handleSaveAs = () => { onSaveAs ? onSaveAs() : appSaveAs(); };
  const handleArchive = () => { onArchive?.(); };
  const handleQuit   = () => { onQuit   ? (onQuit() as any) : appQuit(); };

  const headerBtnClass =
    "h-8 min-w-0 px-1.5 rounded-md border border-[var(--sb-border)] " +
    "bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)] " +
    "text-[11px] font-medium tracking-[0.01em] leading-none " +
    "transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--sb-border-strong)]";

  const saveBtnClass = `${headerBtnClass} border-[color-mix(in_srgb,var(--accent)_32%,var(--sb-border))] bg-[color-mix(in_srgb,var(--accent)_10%,var(--sb-bg))] hover:bg-[color-mix(in_srgb,var(--accent)_16%,var(--sb-bg))]`;

  const folderOpenBtnClass =
    "shrink-0 self-center w-5 h-5 rounded-md border border-[var(--sb-border)] " +
    "bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)] " +
    "text-[var(--text-muted)] grid place-items-center opacity-70 hover:opacity-100 transition-colors transition-opacity " +
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--sb-border-strong)] disabled:opacity-30 disabled:cursor-default";

  function toFileUrl(absPath: string) {
    const raw = (absPath || "").trim();
    if (!raw) return "";
    if (/^file:\/\//i.test(raw)) return raw;

    const slash = raw.replace(/\\/g, "/");

    // Windows drive path: C:/Users/foo -> file:///C:/Users/foo
    if (/^[A-Za-z]:\//.test(slash)) {
      const parts = slash.split("/").map((seg, i) =>
        i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)
      );
      return `file:///${parts.join("/")}`;
    }

    // UNC path: //server/share/folder -> file://server/share/folder
    if (slash.startsWith("//")) {
      const parts = slash.slice(2).split("/").map(encodeURIComponent);
      return `file://${parts.join("/")}`;
    }

    // Unix-like absolute path
    if (slash.startsWith("/")) {
      const parts = slash.slice(1).split("/").map(encodeURIComponent);
      return `file:///${parts.join("/")}`;
    }

    return slash;
  }

  async function openWorkingFolder() {
    const target = (effectiveRoot || workingFolder || "").trim();
    if (!target || !isTauri()) return;

    const notifyFail = async (extra?: string) => {
      try {
        const { message } = await import("@tauri-apps/api/dialog");
        await message(
          `Failed to open folder:
${target}${extra ? `

${extra}` : ""}`,
          { title: "Splitwriter", type: "warning" }
        );
      } catch {
        alert(`Failed to open folder:
${target}`);
      }
    };

    // Keep a quick existence check, but do not let it block explorer fallback.
    try {
      const ok = await fs.exists(target);
      if (!ok) {
        await notifyFail("The folder does not seem to exist.");
        return;
      }
    } catch (existsErr) {
      console.warn("[Sidebar] working folder exists check failed:", existsErr);
    }

    try {
      const { open, Command } = await import("@tauri-apps/api/shell");
      const slashPath = target.replace(/\\/g, "/");
      const fileUrl = toFileUrl(target);

      // 1) Tauri shell.open normal route.
      // 2) Explicit Explorer route for Windows folders.
      const openAttempts: Array<() => Promise<any>> = [
        () => open(target),
        () => open(slashPath),
        () => open(fileUrl),
        () => open(target, "explorer"),
        () => open(target, "explorer.exe"),
      ];

      for (const attempt of openAttempts) {
        try {
          await attempt();
          return;
        } catch (err) {
          console.warn("[Sidebar] shell.open attempt failed:", err);
        }
      }

      // Last resort: direct explorer.exe command.
      // Requires tauri.conf.json allowlist.shell.execute + scope name "explorer".
      try {
        await new Command("explorer", [target]).execute();
        return;
      } catch (cmdErr) {
        console.warn("[Sidebar] explorer command failed:", cmdErr);
        throw cmdErr;
      }
    } catch (err) {
      console.error("Open working folder failed:", err);
      await notifyFail(
        "Tauri shell.open failed. If this persists, enable shell.execute for explorer.exe in tauri.conf.json."
      );
    }
  }

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

  async function deleteFile(absPath: string) {
    if (!isTauri()) return;
    setPendingDelete({ kind: "file", path: absPath, name: absPath.split(/[\\/]/).pop() || absPath });
  }

  async function deleteFolder(absPath: string) {
    if (!isTauri()) return;
    try {
      const entries = await fs.readDir(absPath, { recursive: false });
      if (entries.length > 0) { setDeleteNotice("Folder is not empty."); return; }
      setPendingDelete({ kind: "folder", path: absPath, name: absPath.split(/[\\/]/).pop() || absPath });
    } catch (err) {
      console.error(err);
      setDeleteNotice("Failed to delete folder.");
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      if (target.kind === "file") await fs.removeFile(target.path);
      else {
        const entries = await fs.readDir(target.path, { recursive: false });
        if (entries.length > 0) { setDeleteNotice("Folder is not empty."); return; }
        await fs.removeDir(target.path);
      }
      await refresh();
    } catch (err) {
      console.error(err);
      setDeleteNotice(target.kind === "folder" ? "Failed to delete folder." : "Failed to delete file.");
    }
  }

  function beginRename(absPath: string) {
    if (!isTauri()) return;
    setCtx(null);
    setSelPath(absPath);
    setEditingPath(absPath);
  }

  async function commitRename(absPath: string, input: string) {
    const oldName = absPath.split(/[\\/]/).pop() || "item";
    const cleaned = input.trim().replace(/[\\/:*?"<>|]/g, "_");
    setEditingPath(null);
    if (!cleaned || cleaned === oldName) return;

    // sanitize & Windows case-only workaround
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
        <div className="h-full w-[330px] bg-[var(--sb-bg)] text-[var(--sb-text)] border-r border-[var(--sb-border)] flex flex-col">
          {/* header */}
          <div className="px-3 pt-3 pb-3 border-b border-[var(--sb-border)]">
            <div className="flex items-center justify-between">
              <div className="-ml-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold text-[var(--text-1)]">
                <span aria-hidden="true" className="inline-block h-[9px] w-1 shrink-0 bg-[var(--accent)]" />
                <span>Project</span>
              </div>
              <button className="h-7 px-2 rounded-md text-[11px] text-[var(--text-muted)] hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--sb-border-strong)]"
                onClick={handleQuit} title="Quit (confirm if unsaved)">Quit</button>
            </div>
            <div className="mt-1 grid grid-cols-[minmax(0,1fr)_20px] items-center gap-1.5 min-h-[22px]">
              <div
                className="min-w-0 flex-1 text-[11px] leading-snug break-all opacity-80"
                title={effectiveRoot || ""}
              >
                {effectiveRoot || "(no folder set)"}
                {hasDirty ? <span title="Unsaved changes" className="ml-2 inline-block w-2 h-2 rounded-full bg-[var(--sb-dirty-dot)]" /> : null}
              </div>
              <button
                type="button"
                className={folderOpenBtnClass}
                onClick={(e)=>{ e.stopPropagation(); openWorkingFolder(); }}
                onMouseDown={(e)=>e.stopPropagation()}
                title="Open working folder"
                aria-label="Open working folder"
                disabled={!effectiveRoot || !isTauri()}
              >
                <FolderGlyph open className="text-current" />
              </button>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-1.5">
              <button className={headerBtnClass} onClick={handleNew} title="New project">New</button>
              <button className={saveBtnClass} onClick={handleSave} title="Save (Ctrl+S)">Save</button>
              <button className={headerBtnClass} onClick={handleSaveAs} title="Save As (Ctrl+Shift+S)">Save As</button>
              <button className={headerBtnClass} onClick={handleArchive} title="Archive — Coming in 3.0" aria-label="Archive, coming in version 3.0">Archive (3.0)</button>
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
                editingPath={editingPath}
                onCommitRename={commitRename}
                onCancelRename={()=>setEditingPath(null)}
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
          className="fixed z-[9999] min-w-[178px] bg-[var(--sb-menu-bg)] text-[var(--sb-text)] rounded-[10px] p-1 border border-[var(--sb-border)] shadow-[0_12px_28px_rgba(0,0,0,0.24)] backdrop-blur-md text-[12px] overflow-hidden"
          style={{ left: ctx.x + "px", top: ctx.y + "px" }}
          onMouseDown={stop}
          onPointerDown={stop}
          onContextMenu={stop}  
        >
          {ctx.target.kind === "folder" ? (
            <>
              {root && ctx.target.path === root.path ? (
                <>
                  <CtxBtn onClick={()=>{setCtx(null); newFolder(ctx.target.path);}}>Create Folder</CtxBtn>
                </>
              ) : (
                <>
                  <CtxBtn onClick={()=>{setCtx(null); newFolder(ctx.target.path);}}>Create Folder</CtxBtn>
                  <CtxBtn onClick={()=>{setCtx(null); beginRename(ctx.target.path);}}>Rename</CtxBtn>
                  <div aria-hidden="true" className="my-1 border-t border-[var(--sb-border)]" />
                  <CtxBtn onClick={()=>{setCtx(null); deleteFolder(ctx.target.path);}}>Delete</CtxBtn>
                </>
              )}
            </>
          ) : (
            <>
              <CtxBtn onClick={()=>{ setCtx(null); openAndRemember(ctx.target.path); }}>Open</CtxBtn>
              <CtxBtn onClick={()=>{ setCtx(null); beginRename(ctx.target.path); }}>Rename</CtxBtn>
              <div aria-hidden="true" className="my-1 border-t border-[var(--sb-border)]" />
              <CtxBtn onClick={()=>{ setCtx(null); deleteFile(ctx.target.path); }}>Delete</CtxBtn>
              <CtxBtn onClick={()=>{ setCtx(null); showDetails(ctx.target.path); }}>Details</CtxBtn>
            </>
          )}
        </div>
      )}

      {(pendingDelete || deleteNotice) && createPortal(
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) { setPendingDelete(null); setDeleteNotice(null); } }}
          style={{ position: "fixed", inset: 0, zIndex: 20000, display: "grid", placeItems: "center", padding: 20, background: "rgba(0,0,0,.34)" }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sidebar-delete-title"
            style={{ width: "min(360px, calc(100vw - 40px))", boxSizing: "border-box", padding: 18, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg)", color: "var(--text-1)", boxShadow: "0 12px 32px rgba(0,0,0,.28)" }}
          >
            <div id="sidebar-delete-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              {deleteNotice ? "Notice" : "Confirm deletion"}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-2)", marginBottom: 18 }}>
              {deleteNotice || (pendingDelete?.kind === "folder"
                ? `Are you sure you want to delete the folder “${pendingDelete.name}”? This cannot be undone.`
                : `Are you sure you want to delete “${pendingDelete?.name ?? ""}”? This cannot be undone.${hasDirty ? " There are unsaved changes." : ""}`)}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              {deleteNotice ? (
                <button type="button" onClick={() => setDeleteNotice(null)} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--btn-bg)", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>OK</button>
              ) : (
                <>
                  <button type="button" onClick={() => setPendingDelete(null)} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--btn-bg)", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                  <button type="button" onClick={confirmDelete} style={{ padding: "6px 12px", border: "1px solid color-mix(in srgb, #e35d5d 55%, transparent)", borderRadius: 5, background: "color-mix(in srgb, #e35d5d 16%, transparent)", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Confirm</button>
                </>
              )}
            </div>
          </section>
        </div>, document.body
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
  editingPath: string | null; onCommitRename:(abs:string, name:string)=>void; onCancelRename:()=>void;
  currentOpen: string;
}) {
  const { node, depth, selected } = props;
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const isRenaming = props.editingPath === node.path;

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(node.name);
      requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); });
    }
  }, [isRenaming, node.name]);

  const renderName = (name: string) => isRenaming ? (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={(event) => setRenameValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || (event as any).keyCode === 13) && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); props.onCommitRename(node.path, renameValue);
        } else if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); props.onCancelRename();
        }
      }}
      className="min-w-0 flex-1 bg-transparent border-b border-[var(--accent)] text-[var(--text-1)] text-[13.3px] outline-none"
      aria-label={`Rename ${name}`}
    />
  ) : <span className="text-[13.3px] truncate group-hover:text-[var(--text-1)]">{name}</span>;

  if (node.kind === "folder") {
    const isRoot = depth === 0 && node.name === "__ROOT__";
    const shown  = isRoot ? node.path : node.name;
    const showOpenIcon = node.open && node.children.length > 0;
    const isSel = selected === node.path;

    return (
      <div>
        <div
          className={`group flex items-center gap-2 px-2 py-1.5 cursor-default select-none hover:bg-[var(--sb-hover)] hover:text-[var(--text-1)] ${isSel ? "bg-[var(--sb-selected)]" : (isRoot ? "bg-[var(--sb-root-row)]" : "")}`}
          onClick={(e)=>{ props.onSelect(node.path); props.onToggleOpen(node.path); stop(e); }}
          onContextMenu={(e)=>{ props.onSelect(node.path); props.onContextMenu(e,node); }}
          onDragOver={props.enableDragMove ? (e)=>props.onDragOverFolder(e,node) : undefined}
          onDrop={props.enableDragMove ? (e)=>props.onDropOnFolder(e,node) : undefined}
          draggable={props.enableDragMove && !isRoot}
          onDragStart={props.enableDragMove ? (e)=> props.onStartDrag(e, node) : undefined}
          title={shown}
        >
          <FolderGlyph open={showOpenIcon} className={showOpenIcon ? "opacity-80" : "opacity-65"} />
          {renderName(shown)}
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
            : "hover:bg-[var(--sb-hover)] hover:text-[var(--text-1)]")
      }
      onClick={(e)=>{ props.onSelect(node.path); stop(e); }}
      onDoubleClick={(e)=>{ props.onOpenFile?.(node.path); stop(e); }}
      onContextMenu={(e)=>{ props.onSelect(node.path); props.onContextMenu(e,node); }}
      draggable={props.enableDragMove}
      onDragStart={props.enableDragMove ? (e)=>props.onStartDrag(e,node) : undefined}
      title={node.name}
    >
      <FileGlyph className={isOpenNow ? "text-[var(--accent)]" : "text-[var(--text-muted)] opacity-80"} />
      {isRenaming ? renderName(node.name) : (
        <span className="flex-1 text-left text-[13.3px] truncate group-hover:text-[var(--text-1)]" style={isOpenNow ? { color: "var(--accent)" } : undefined}>
          {node.name}
        </span>
      )}
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
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)]"
                  onClick={onCancel}>Cancel</button>
          <button className="px-3 py-1.5 rounded bg-[var(--sb-btn-bg)] hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)]"
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
  const detailCell = (label: string, value: string) => (
    <div className="min-w-0 rounded-lg border border-[var(--sb-border)] bg-[var(--sb-root-row)] px-3 py-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</div>
      <div className="break-words text-[13px] leading-snug text-[var(--text-1)]">{value || "—"}</div>
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 z-[10000] bg-[var(--sb-backdrop)]" onClick={onClose}/>
      <div role="dialog" aria-modal="true" aria-labelledby="swon-details-title" className="fixed z-[10001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                      w-[480px] max-w-[94vw] overflow-hidden rounded-xl border border-[var(--sb-border)]
                      bg-[var(--sb-menu-bg)] text-[var(--sb-text)] shadow-[0_16px_40px_rgba(0,0,0,.28)]">
        <header className="flex items-center gap-3 border-b border-[var(--sb-border)] px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_12%,var(--sb-bg))] text-[var(--accent)]">
            <FileGlyph />
          </span>
          <div className="min-w-0 flex-1">
            <div id="swon-details-title" className="text-sm font-semibold leading-tight">File details</div>
            <div className="mt-1 text-[11px] text-[var(--text-muted)]">SWON project file</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sb-btn-bg-hover)] hover:text-[var(--text-1)]">×</button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-[var(--sb-border)] bg-[var(--sb-root-row)] px-3 py-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Location</div>
            <div className="break-all text-[11px] leading-relaxed text-[var(--text-2)]">{file}</div>
          </div>

          {!meta ? (
            <div className="rounded-lg border border-[var(--sb-border)] px-3 py-3 text-sm text-[var(--text-2)]">Not a SWON file.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {detailCell("Kind", meta.kind)}
                {detailCell("Version", String(meta.version ?? "—"))}
                {detailCell("Title", meta.title)}
                {detailCell("Saved at", meta.savedAt)}
              </div>

              <section>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Contents</div>
                <div className="grid grid-cols-3 gap-2">
                  {(["OpenText", "Archived", "Images"] as const).map((label, index) => {
                    const value = [meta.counts.openText, meta.counts.archivedText, meta.counts.images][index];
                    return (
                      <div key={label} className="rounded-lg border border-[var(--sb-border)] bg-[var(--sb-root-row)] px-3 py-2">
                        <div className="text-[10px] leading-tight text-[var(--text-muted)]">{label}</div>
                        <div className="mt-1 text-base font-semibold tabular-nums text-[var(--text-1)]">{value}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--sb-border)] px-5 py-3">
          <button type="button" className="rounded-md border border-[var(--sb-border)] bg-[var(--sb-btn-bg)] px-3 py-1.5 text-xs text-[var(--text-1)] transition-colors hover:bg-[var(--sb-btn-bg-hover)]" onClick={onClose}>Close</button>
          <button type="button" className="rounded-md border border-[color-mix(in_srgb,var(--accent)_38%,var(--sb-border))] bg-[color-mix(in_srgb,var(--accent)_12%,var(--sb-bg))] px-3 py-1.5 text-xs font-medium text-[var(--text-1)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_20%,var(--sb-bg))]" onClick={onOpen}>Open file</button>
        </footer>
      </div>
    </>
  );
}

/* ------------------------------ Ctx button -------------------------------- */
function CtxBtn({ children, onClick }: { children: React.ReactNode; onClick:()=>void; }) {
  return (
    <button
      className="w-full h-[30px] text-left px-2.5 rounded-[7px] hover:bg-[var(--sb-hover)] hover:text-[var(--text-1)] text-[12px] font-medium tracking-[0.005em] transition-colors"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
