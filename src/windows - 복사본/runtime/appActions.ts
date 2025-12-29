// src/windows/runtime/appActions.ts
/**
 * Splitwriter의 파일 액션을 총괄하는 모듈.
 *
 * - Open / Save / Save As / New / Reload / Quit
 * - 변경사항 확인, 다이얼로그, 타이틀바 동기화까지 여기서 처리
 */

import { emit } from "@tauri-apps/api/event";

/* ---------- Types ---------- */
type IO = {
  isDirty: () => boolean;
  save: () => Promise<void | string | null>;
  saveAs: (absPath?: string) => Promise<void | string | null>;
  open: () => Promise<void | string | null>;
  newFile: () => void | Promise<void>;
  notify?: (msg: string, lvl?: "info" | "warn" | "error", ttl?: number) => void;
};

type Ask3 = (msg: string) => Promise<"save" | "discard" | "cancel">;

type Messages = {
  OPEN: string;
  NEW: string;
  QUIT: string;
  RELOAD: string;
};

type Deps = {
  io: IO;
  ask: (msg: string) => Promise<boolean>;
  ask3?: Ask3;
  hasBoundFileRef?: { current: boolean };
  messages?: Partial<Messages>;
};

type Store = {
  io: IO;
  ask: (msg: string) => Promise<boolean>;
  ask3?: Ask3;
  hasBoundFileRef: { current: boolean };
  messages: Messages;
};

let D: Store | null = null;
let currentFilePath: string | null = null;
let _saveAsInFlight: Promise<string | null> | null = null;

declare global {
  interface Window {
    __SW_CURRENT_FILE__?: string;
  }
}

/* ---------- helpers ---------- */

function need(): Store {
  if (!D) throw new Error("initAppActions() must be called first");
  return D;
}

function _readGlobalPath(): string | null {
  try {
    const p = (window as any).__SW_CURRENT_FILE__;
    return typeof p === "string" && p ? p : null;
  } catch {
    return null;
  }
}

function _basename(p?: string | null): string {
  if (!p) return "";
  const m = String(p).match(/[^\\/]+$/);
  return m ? m[0] : String(p);
}

function currentFileLabel(): string {
  try {
    const p = (window as any).__SW_CURRENT_FILE__ as string | undefined;
    return p ? _basename(p) : "";
  } catch {
    return "";
  }
}

async function getAppWindow() {
  try {
    if ((window as any).__TAURI_IPC__) {
      const { appWindow } = await import("@tauri-apps/api/window");
      return appWindow;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 전역 경로 + 타이틀바 이벤트 + Tauri 이벤트까지 한 번에 동기화.
 */
export function noteCurrentFile(path: string | null) {
  const p = path || null;
  currentFilePath = p;

  // 1) 전역 변수 (TitleBar 폴링용)
  try {
    (window as any).__SW_CURRENT_FILE__ = p || "";
  } catch {
    /* ignore */
  }

  const detail = { path: p };

  // 2) DOM 이벤트 (TitleBar useEffect가 듣고 있음)
  if (!p) {
    window.dispatchEvent(new CustomEvent("sw:file:cleared", { detail }));
  } else {
    window.dispatchEvent(new CustomEvent("sw:file:opened", { detail }));
    window.dispatchEvent(new CustomEvent("sw:file:label", { detail }));
  }

  // 3) Tauri 이벤트 (선택적)
  if ((window as any).__TAURI_IPC__) {
    void (async () => {
      try {
        await emit("sw:opened", detail);
      } catch {
        /* ignore */
      }
    })();
  }
}

export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

/* ---------- init ---------- */

export function initAppActions(deps: Deps) {
  const base: Messages = {
    OPEN: "Open a project? Unsaved changes will be lost.",
    NEW: "Create a new project? Unsaved changes will be lost.",
    QUIT: "There are unsaved changes.\nQuit without saving?",
    RELOAD: "Save before reload?",
  };

  const merged: Messages = { ...base, ...(deps.messages || {}) };
  const { messages: _omit, ...rest } = deps;

  D = {
    io: rest.io,
    ask: rest.ask,
    ask3: (rest as any).ask3,
    hasBoundFileRef: rest.hasBoundFileRef ?? { current: false },
    messages: merged,
  };

  // 앱 시작 시 한 번 초기 라벨 정리
  if (typeof window !== "undefined") {
    const initial = _readGlobalPath();
    if (initial) noteCurrentFile(initial);
    else noteCurrentFile(null);
  }
}

/* ---------- 공용 helpers ---------- */

async function trySave(): Promise<boolean> {
  const { io } = need();
  try {
    await io.save(); // Save or Save As(경로 없을 때)
    return !io.isDirty();
  } catch {
    return false;
  }
}

function ensureSwonExt(p: string) {
  return /\.swon$/i.test(p) ? p : `${p}.swon`;
}

/* ---------- actions ---------- */

export async function save() {
  const { io } = need();
  const before = _readGlobalPath() || currentFilePath;
  const ret = await io.save(); // void | string | null

  const path =
    (typeof ret === "string" && ret) ||
    _readGlobalPath() ||
    before ||
    null;

  if (path) noteCurrentFile(path);
}

/**
 * Save As:
 * - Tauri dialog로 한 번만 경로를 고른다.
 * - IO.saveAt(path) 또는 IO.saveAs(path)/save() 호출
 * - 성공하면 noteCurrentFile(path)로 타이틀바 갱신
 */
export async function saveAsAndBind(): Promise<string | null> {
  if (_saveAsInFlight) return _saveAsInFlight;

  _saveAsInFlight = (async () => {
    const { io, hasBoundFileRef } = need();
    const saveAsFn: any = (io as any).saveAs;
    const hasSaveAt = typeof (io as any).saveAt === "function";
    const saveAsTakesPath =
      typeof saveAsFn === "function" && saveAsFn.length >= 1;

    let path: string | null = null;

    try {
      if (hasSaveAt || saveAsTakesPath) {
        const { save: pickSave } = await import("@tauri-apps/api/dialog");
        const picked0 = await pickSave({
          defaultPath: currentFileLabel() || "Untitled.swon",
          filters: [{ name: "Splitwriter", extensions: ["swon"] }],
        });
        if (!picked0) return null;

        const picked = ensureSwonExt(String(picked0));

        if (hasSaveAt) {
          await (io as any).saveAt(picked);
        } else {
          await saveAsFn(picked);
        }

        path = picked;
      } else if (typeof saveAsFn === "function") {
        const ret = await saveAsFn(); // string | void | null
        path = (typeof ret === "string" && ret) || _readGlobalPath();
      } else {
        const ret = await io.save();
        path = (typeof ret === "string" && ret) || _readGlobalPath();
      }

      if (!path) {
        const fallback = _readGlobalPath();
        if (fallback) path = fallback;
      }

      if (path) {
        noteCurrentFile(path);
        hasBoundFileRef.current = true;
      }
      return path || null;
    } finally {
      _saveAsInFlight = null;
    }
  })();

  return _saveAsInFlight;
}

/**
 * Ctrl+O / 메뉴 Open...
 */
export async function openWithGuard(): Promise<void> {
  const { io, ask, messages, hasBoundFileRef } = need();

  if (io.isDirty() && !(await ask(messages.OPEN))) return;

  const ret = await io.open(); // void | string | null

  const path =
    (typeof ret === "string" && ret) ||
    _readGlobalPath() ||
    null;

  if (path) {
    noteCurrentFile(path);
    hasBoundFileRef.current = true;
  }
}

/**
 * Sidebar / 외부에서 절대 경로를 알고 있을 때 그 파일을 여는 함수.
 * - openWithGuard 와 동일하게 변경사항 확인
 * - IO 가 제공하는 경로 기반 open 함수를 우선 사용
 */
export async function openByPath(absPath: string): Promise<void> {
  const { io, ask, messages, hasBoundFileRef } = need();

  if (!absPath) return;

  // 이미 같은 파일이면 무시
  const before = _readGlobalPath() || currentFilePath;
  if (before && before === absPath) return;

  // 변경사항 경고
  if (io.isDirty() && !(await ask(messages.OPEN))) return;

  const anyIO: any = io;
  let ret: any = null;

  // 1순위: 경로 기반 헬퍼들
  if (typeof anyIO.openAt === "function") {
    ret = await anyIO.openAt(absPath);
  } else if (typeof anyIO.openByPath === "function") {
    ret = await anyIO.openByPath(absPath);
  } else if (typeof anyIO.openFile === "function") {
    ret = await anyIO.openFile(absPath);
  } else if (typeof anyIO.openSwon === "function") {
    ret = await anyIO.openSwon(absPath);
  } else if (typeof anyIO.open === "function" && anyIO.open.length >= 1) {
    // open(path) 형태를 지원하는 경우
    ret = await anyIO.open(absPath);
  } else if (typeof anyIO.open === "function") {
    // 최후 폴백: 기존 Ctrl+O 방식(다이얼로그) 그대로
    ret = await anyIO.open();
  }

  const path =
    (typeof ret === "string" && ret) ||
    absPath ||
    _readGlobalPath() ||
    null;

  if (path) {
    noteCurrentFile(path);
    hasBoundFileRef.current = true;
  }
}

/** Sidebar 가 찾는 이름들과 맞추기 위한 alias 들 */
export async function openFile(absPath: string) {
  return openByPath(absPath);
}
export async function openSwon(absPath: string) {
  return openByPath(absPath);
}
export async function openFileWithGuard(absPath: string) {
  return openByPath(absPath);
}
export async function openSwonWithGuard(absPath: string) {
  return openByPath(absPath);
}

export async function newWithGuard() {
  const { io, ask, messages, hasBoundFileRef } = need();
  if (io.isDirty() && !(await ask(messages.NEW))) return;

  await io.newFile();
  hasBoundFileRef.current = false;
  noteCurrentFile(null);
}

export async function reloadWithGuard() {
  const { io, ask, messages } = need();
  if (io.isDirty()) {
    const okAsk = await ask(messages.RELOAD);
    if (!okAsk) return;
    const okSave = await trySave();
    if (!okSave) return;
  }
  location.reload();
}

export async function quitWithGuard() {
  const { io, ask, ask3, messages } = need();
  const dirty = io.isDirty();
  const aw = await getAppWindow();

  const fname = currentFileLabel();
  const ASK_SAVE = fname
    ? `Save '${fname}' before exit?`
    : "Save before exit?";
  const ASK_DISCARD = fname
    ? `Quit without saving '${fname}'?`
    : messages.QUIT;

  if (aw) {
    if (!dirty) {
      await aw.close();
      return;
    }

    if (ask3) {
      const choice = await ask3(ASK_SAVE);
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await trySave();
        if (!ok) return;
        await aw.close();
        return;
      }
      await aw.close();
      return;
    }

    const wantSave = await ask(ASK_SAVE);
    if (wantSave) {
      const ok = await io
        .save()
        .then(() => true)
        .catch(() => false);
      if (!ok) return;
      await aw.close();
      return;
    }
    const really = await ask(ASK_DISCARD);
    if (really) await aw.close();
    return;
  }

  if (dirty) {
    if (ask3) {
      const choice = await ask3(ASK_SAVE);
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await trySave();
        if (!ok) return;
        window.close();
        return;
      }
      window.close();
      return;
    }

    const wantSave = await ask(ASK_SAVE);
    if (wantSave) {
      const ok = await trySave();
      if (!ok) return;
      window.close();
      return;
    }
    const really = await ask(ASK_DISCARD);
    if (!really) return;
  }

  window.close();
}

/**
 * StatusBar 텍스트에서 *.swon 파일명을 뽑아서
 * 타이틀바 / 전역 라벨에 반영하는 헬퍼.
 *
 * 예)
 *  - "image.swon loaded"
 *  - "Saved: image2.swon"
 * 같은 문자열에서 마지막 *.swon 만 추출해서 사용한다.
 */
export function updateTitleFromStatus(status: string) {
  // status 가 이상하면: 경로가 이미 있으면 그대로 유지만 해준다.
  if (typeof status !== "string") {
    const existing = _readGlobalPath() || currentFilePath;
    if (existing) {
      noteCurrentFile(existing);
    } else {
      noteCurrentFile(null);
    }
    return;
  }

  // "image.swon loaded" 같은 문자열에서 파일명만 뽑아내기
  const m = status.match(/([^\s\\/]+\.swon)/i);
  const name = m ? m[1] : "";

  const existing = _readGlobalPath() || currentFilePath;

  if (existing) {
    // 이미 절대 경로를 알고 있으면,
    // 경로는 그대로 두고 타이틀바 이벤트만 다시 쏴준다.
    noteCurrentFile(existing);
    return;
  }

  // 아직 경로를 모르는 (새 문서 등) 케이스에서만
  // 예전처럼 파일명 기반으로 라벨을 세팅
  noteCurrentFile(name || null);
}