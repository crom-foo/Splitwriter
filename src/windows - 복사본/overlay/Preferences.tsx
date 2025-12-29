import React, { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { readDir, writeTextFile, readTextFile, createDir } from "@tauri-apps/api/fs";
import { homeDir, join } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/api/os";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { listPresets, loadPreset, savePreset, applyDefault, revealPresetFolder } from "../../shared/presets";
import { DEFAULT_PREFS, type Preferences, type FontTriplet, SYSTEM_STACK, SYSTEM_LABEL } from "../../shared/defaultPrefs";
import { emit } from "@tauri-apps/api/event";
import { applyAccentTokens } from "../runtime/accent";
import curlyIconUrl from "../icons/curly.png";

export const PREFS_STORAGE_KEY = "splitwriter:preferences:v4";
const FALLBACK_ACCENT = "#2AA4FF";

// 공통 Autosave Interval 후보들 (sec)
const AUTOSAVE_INTERVAL_CHOICES = [10, 30, 60, 120, 300, 600];

// UI(Preferences)에서 명시적으로 바꾼 workingFolder 인지 표시하는 1회용 플래그
let nextWorkingFolderChangeFromUI = false;

/** Working folder guard: treat first root as project root, ignore “deeper” subfolder changes. */
function normalizePath(p?: string) {
  if (!p) return "";
  return p
    .replace(/^\\\\\?\\/, "") // Strip Windows device prefix
    .replace(/\\/g, "/") // Normalize slashes
    .replace(/\/+$/, "") // Trim trailing slashes
    .toLowerCase();
}

function isSubPathOf(parent: string, child: string) {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  return !!p && !!c && c.startsWith(p + "/");
}

/** Deprecated: external text-engine CSS injection.
 *  Splitwriter v4 applies typefaces inside TextBoard.
 *  Keeping this stub to avoid regressions.
 */
function installPresetCSS(_tf: Preferences["typeface"]) {
  // no-op
}

export function usePreferences() {
  // 실제 state setter
  const [prefs, rawSetPrefs] = React.useState<Preferences>(() => {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Preferences>;
        if (!parsed.typeface?.etc) {
          parsed.typeface = { ...DEFAULT_PREFS.typeface, ...parsed.typeface, etc: DEFAULT_PREFS.typeface.etc };
        }

        const merged: Preferences = {
          ...DEFAULT_PREFS,
          workingFolder: parsed.workingFolder ?? DEFAULT_PREFS.workingFolder,
          autosave: parsed.autosave ?? DEFAULT_PREFS.autosave,
          autosaveIntervalSec: parsed.autosaveIntervalSec ?? DEFAULT_PREFS.autosaveIntervalSec,
          typeface: {
            headline: parsed.typeface?.headline ?? DEFAULT_PREFS.typeface.headline,
            body: parsed.typeface?.body ?? DEFAULT_PREFS.typeface.body,
            accent: parsed.typeface?.accent ?? DEFAULT_PREFS.typeface.accent,
            etc: parsed.typeface?.etc ?? DEFAULT_PREFS.typeface.etc,
          },
          accentColor: parsed.accentColor ?? DEFAULT_PREFS.accentColor,
          writingGoal: parsed.writingGoal ?? DEFAULT_PREFS.writingGoal,
          bracket: parsed.bracket ?? DEFAULT_PREFS.bracket,
          theme: (parsed as any)?.theme ?? DEFAULT_PREFS.theme,
        };
        merged.typeface = normalizeTypeface(merged.typeface);
        return merged;
      }

      const v2 = localStorage.getItem("splitwriter:preferences:v2");
      if (v2) {
        const p = JSON.parse(v2) as any;
        const tf = p.typeface || p.fonts || {};
        const fromV2: Preferences = {
          ...DEFAULT_PREFS,
          ...p,
          theme: p.theme ?? "dark",
          typeface: {
            headline: tf.headline ?? DEFAULT_PREFS.typeface.headline,
            body: tf.body ?? DEFAULT_PREFS.typeface.body,
            accent: tf.accent ?? DEFAULT_PREFS.typeface.accent,
            etc: tf.etc ?? tf.etc2 ?? DEFAULT_PREFS.typeface.etc,
          },
          bracket: p.bracket ? stripLegacyBrackets(p.bracket) : DEFAULT_PREFS.bracket,
          writingGoal: p.writingGoal ?? DEFAULT_PREFS.writingGoal,
        };
        fromV2.typeface = normalizeTypeface(fromV2.typeface);
        return fromV2;
      }
      return DEFAULT_PREFS;
    } catch {
      return DEFAULT_PREFS;
    }
  });

  // “프로젝트 루트”를 한 번 잡아두는 레퍼런스 (Sidebar 와 동일한 개념)
  const lockedRootRef = React.useRef<string>("");

  // 직전 workingFolder 변경이 UI(Preferences)에서 온 것인지 기록
  const lastWFChangeFromUIRef = React.useRef(false);

  // workingFolder 가 바뀔 때마다:
  // - 첫 비어있지 않은 값은 루트로 채택
  // - 이후 완전히 다른 경로(D: 등)로 바뀌면 루트를 갈아끼우고
  // - 기존 루트의 하위 폴더로 줄어드는 변화는 무시하도록 플래그만 유지
  useEffect(() => {
    const wf = (prefs.workingFolder || "").trim();
    if (!wf) return;

    const prev = lockedRootRef.current;

    // 바로 직전 변경이 UI(Preferences)에서 온 경우에는
    // “루트 교체” 로 보고 무조건 새 값을 루트로 채택
    if (lastWFChangeFromUIRef.current) {
      lockedRootRef.current = wf;
      lastWFChangeFromUIRef.current = false;
      return;
    }

    if (!prev) {
      lockedRootRef.current = wf;
      return;
    }
    if (isSubPathOf(prev, wf)) {
      // ex) C:\Foo\Bar → C:\Foo\Bar\Sub : 파일 열림 때문에 내려간 거로 보고 무시
      return;
    }
    // ex) C:\Foo\Bar → D:\Novel\Project : 완전히 다른 루트로 바뀐 경우
    lockedRootRef.current = wf;
  }, [prefs.workingFolder]);

  // 모든 setPrefs 호출을 감싸서
  // - workingFolder 는 오직 Preferences UI 에서만 변경 가능
  // - 그 외에서 바꾸려 하면 이전 값으로 되돌리고, 콘솔에 로그를 남긴다.
  const setPrefs: React.Dispatch<React.SetStateAction<Preferences>> = React.useCallback(
    (updater) => {
      rawSetPrefs((prev) => {
        const prevWF = (prev.workingFolder || "").trim();

        let next: Preferences;
        if (typeof updater === "function") {
          // prev 를 직접 mutate 하는 코드까지 막기 위해 복사본을 넘겨준다.
          const draft = { ...prev };
          next = (updater as (p: Preferences) => Preferences)(draft);
        } else {
          next = updater as Preferences;
        }

        const nextWF = (next.workingFolder || "").trim();

        // workingFolder 가 실제로 바뀌려고 할 때만 검사
        if (prevWF !== nextWF) {
          const fromUI = nextWorkingFolderChangeFromUI;
          // 플래그는 항상 한 번 쓰고 초기화
          nextWorkingFolderChangeFromUI = false;

          // 1) Preferences UI 에서 바꾼 경우 → 허용 + 루트 교체 플래그
          if (fromUI) {
            if (nextWF) {
              lastWFChangeFromUIRef.current = true;
            }
            return next;
          }

          // 2) 초기 상태(이전 값이 비어있고, 새 값이 생기는 경우)는 한 번은 허용
          if (!prevWF && nextWF) {
            return next;
          }

          // 3) 나머지 모든 경우는 외부에서 workingFolder 를 건드린 것으로 보고 되돌린다.
          console.warn("[prefs] blocked external workingFolder change", {
            prevWF,
            requested: nextWF,
            stack: new Error().stack,
          });

          return { ...next, workingFolder: prevWF };
        }

        // workingFolder 변경이 없는 일반 prefs 업데이트
        nextWorkingFolderChangeFromUI = false;
        return next;
      });
    },
    []
  );

  useEffect(() => {
    try {
      installPresetCSS(prefs.typeface);
    } catch (e) {
      console.warn(e);
    }
  }, [prefs.typeface]);

  useEffect(() => {
    const toStore = {
      workingFolder: prefs.workingFolder,
      autosave: prefs.autosave,
      autosaveIntervalSec: prefs.autosaveIntervalSec,
      typeface: prefs.typeface,
      accentColor: prefs.accentColor,
      writingGoal: prefs.writingGoal,
      bracket: prefs.bracket,
      theme: prefs.theme,
    };
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(toStore));
    } catch {}
    try {
      emit("prefs-changed", {});
    } catch {}

    (async () => {
      await writeShadowPrefs(toStore);
    })();
  }, [prefs]);

  useEffect(() => {
    applyAccentTokens(validateHex(prefs.accentColor) || FALLBACK_ACCENT);
  }, [prefs.accentColor]);

  useEffect(() => {
    applyThemeDom(prefs.theme);
  }, [prefs.theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromFile = await readShadowPrefs();

      if (cancelled) return;

      if (fromFile) {
        setPrefs((prev) => {
          const p = fromFile as Partial<Preferences>;
          const merged: Preferences = {
            ...DEFAULT_PREFS,
            workingFolder: p.workingFolder ?? prev.workingFolder,
            autosave: p.autosave ?? prev.autosave,
            autosaveIntervalSec: p.autosaveIntervalSec ?? prev.autosaveIntervalSec,
            theme: p.theme ?? prev.theme,
            typeface: normalizeTypeface({
              headline: p.typeface?.headline ?? prev.typeface.headline,
              body: p.typeface?.body ?? prev.typeface.body,
              accent: p.typeface?.accent ?? prev.typeface.accent,
              etc: p.typeface?.etc ?? prev.typeface.etc,
            }),
            accentColor: p.accentColor ?? prev.accentColor,
            writingGoal: p.writingGoal ?? prev.writingGoal,
            bracket: p.bracket ?? prev.bracket,
          };
          return merged;
        });
      } else {
        setPrefs((prev) => {
          // Factory reset: keep previous accentColor, reset other fields to DEFAULT_PREFS
          const next: Preferences = {
            ...DEFAULT_PREFS,
            accentColor: prev.accentColor,
          };
          next.typeface = normalizeTypeface(next.typeface);
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return [prefs, setPrefs] as const;
}

const IcFolder = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden width={16} height={16} {...p}>
    <path
      fill="currentColor"
      d="M3 6.75A1.75 1.75 0 0 1 4.75 5h4.19c.46 0 .9.18 1.22.5l.56.56c.33.33.77.51 1.23.51h5.55A1.75 1.75 0 0 1 19.25 9v8.25A1.75 1.75 0 0 1 17.5 19h-13A1.75 1.75 0 0 1 2.75 17.25v-9.5Z"
    />
  </svg>
);
const IcClock = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden width={16} height={16} {...p}>
    <path
      fill="currentColor"
      d="M12 2.75a9.25 9.25 0 1 0 0 18.5 9.25 9.25 0 0 0 0-18.5Zm.75 4.75a.75.75 0 1 0-1.5 0v5.06c0 .3.17.57.45.69l3.72 1.66a.75.75 0 0 0 .63-1.36l-3.3-1.47V7.5Z"
    />
  </svg>
);
const IcA = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden width={16} height={16} {...p}>
    <path fill="currentColor" d="M12.92 6.2 16.5 17h-2l-.84-2.6H8.37L7.5 17h-2l3.62-10.8h3.8Zm-3.9 6.3h3.06L10.5 8.4 9.02 12.5Z" />
  </svg>
);

async function shadowPrefDir() {
  const base = await homeDir();
  return await join(base, "Splitwriter");
}
async function shadowPrefPath() {
  const dir = await shadowPrefDir();
  return await join(dir, "prefs.json");
}

async function writeShadowPrefs(obj: any) {
  if (!isTauri()) return;
  try {
    const dir = await shadowPrefDir();
    await createDir(dir, { recursive: true });
    const file = await shadowPrefPath();
    await writeTextFile(file, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn("[prefs] writeShadowPrefs failed:", e);
  }
}

async function readShadowPrefs(): Promise<any | null> {
  if (!isTauri()) return null;
  try {
    const file = await shadowPrefPath();
    const txt = await readTextFile(file);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export async function bootstrapPrefsOnAppStart() {
  try {
    let fromShadow: any = await readShadowPrefs();
    if (!fromShadow) {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) fromShadow = JSON.parse(raw);
    }

    const merged: Preferences = {
      ...DEFAULT_PREFS,
      workingFolder: fromShadow?.workingFolder ?? DEFAULT_PREFS.workingFolder,
      autosave: fromShadow?.autosave ?? DEFAULT_PREFS.autosave,
      autosaveIntervalSec: fromShadow?.autosaveIntervalSec ?? DEFAULT_PREFS.autosaveIntervalSec,
      typeface: {
        headline: fromShadow?.typeface?.headline ?? DEFAULT_PREFS.typeface.headline,
        body: fromShadow?.typeface?.body ?? DEFAULT_PREFS.typeface.body,
        accent: fromShadow?.typeface?.accent ?? DEFAULT_PREFS.typeface.accent,
        etc: fromShadow?.typeface?.etc ?? DEFAULT_PREFS.typeface.etc,
      },
      accentColor: fromShadow?.accentColor ?? DEFAULT_PREFS.accentColor,
      writingGoal: fromShadow?.writingGoal ?? DEFAULT_PREFS.writingGoal,
      bracket: fromShadow?.bracket ?? DEFAULT_PREFS.bracket,
      // Merge other optional fields (e.g., theme/language) here when needed
      theme: fromShadow?.theme ?? DEFAULT_PREFS.theme,
      language: fromShadow?.language ?? (DEFAULT_PREFS as any).language,
    };
    merged.typeface = normalizeTypeface(merged.typeface);

    // NEW: persist the bootstrap result so usePreferences() can pick it up immediately
    try {
      const toStore = {
        workingFolder: merged.workingFolder,
        autosave: merged.autosave,
        autosaveIntervalSec: merged.autosaveIntervalSec,
        typeface: merged.typeface,
        accentColor: merged.accentColor,
        writingGoal: merged.writingGoal,
        bracket: merged.bracket,
        theme: merged.theme,
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(toStore));
    } catch {}

    try {
      installPresetCSS(merged.typeface);
    } catch {}

    const acc = validateHex(merged.accentColor) || FALLBACK_ACCENT;
    applyAccentTokens(acc);
    applyThemeDom(merged.theme);

    try {
      await emit("prefs-changed", {});
    } catch {}
  } catch (e) {
    console.warn("[prefs bootstrap] failed:", e);
  }
}

const STRINGS = {
  en: {
    title: "Preferences",
    close: "Close",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    workingFolder: "Working Folder",
    workingFolderHint: "Default save location for Splitwriter",
    browse: "Browse…",
    autosave: "Autosave",
    autosaveDesc: "Periodically saves while you type.",
    autosaveInterval: "Autosave Interval (sec)",
    autosaveRange: "Recommended 10–600",
    fonts: "Typeface Presets (v4)",
    fontsHint: "Ctrl/Cmd + 1·2·3·4 to switch (Headline / Body / Accent / Etc)",
    headline: "Headline",
    body: "Body",
    accent: "Accent",
    etc: "Etc",
    preview: "Preview",
    accentColor: "Accent Color",
    accentDesc: "Used for highlights and focus. Stored as HEX.",
    bracket: "Curly Braces Replacement",
    bracketDesc: "Replace { and } while typing.",
    enable: "Enable",
    none: "None",
    doubleCorner: "『 』 (double corner)",
    doubleAngle: "≪ ≫ (double angle)",
    singleCorner: "｢ ｣ (single corner)",
    singleAngle: "< > (single angle)",
    goalTitle: "Writing Goal (HUD)",
    goalDesc: "Show a small counter on screen while writing.",
    goalEnable: "Enable",
    goalUnit: "Unit",
    unitChars: "Characters",
    unitWords: "Words",
    goalTarget: "Target",
    goalPreview: "Preview",
  },
} as const;

type LangKey = keyof typeof STRINGS;

function normalizeTypeface(tf: Preferences["typeface"]) {
  const norm = (f: FontTriplet): FontTriplet =>
    f.name === SYSTEM_LABEL ? { ...f, name: SYSTEM_STACK } : f;
  return {
    headline: norm(tf.headline),
    body: norm(tf.body),
    accent: norm(tf.accent),
    etc: norm(tf.etc),
  };
}

const BRACKET_MAP: Record<Preferences["bracket"]["style"], [string, string]> = {
  none: ["{", "}"],
  doubleCorner: ["『", "』"],
  doubleAngle: ["≪", "≫"],
  singleCorner: ["｢", "｣"],
  singleAngle: ["<", ">"],
};
const NONE_STYLE = "(none)";

type FontDict = Record<string, Set<string>>;
function buildFallbackFonts(): FontDict {
  const map: FontDict = {};
  const add = (fam: string, styles: string[]) => {
    if (!map[fam]) map[fam] = new Set();
    styles.forEach((s) => map[fam].add(s));
  };
  add("Inter", ["Thin", "Light", "Regular", "Medium", "Semibold", "Bold", "Black"]);
  add("Noto Sans KR", ["Regular", "Medium", "Bold", "Black"]);
  add("Segoe UI", ["Regular", "Semibold", "Bold"]);
  add("Malgun Gothic", ["Regular", "Bold"]);
  add("Arial", ["Regular", "Bold", "Italic", "Bold Italic"]);
  add("Times New Roman", ["Regular", "Bold", "Italic", "Bold Italic"]);
  add("Roboto", ["Thin", "Light", "Regular", "Medium", "Bold", "Black"]);
  add("Pretendard", ["Regular", "Medium", "Semibold", "Bold"]);
  return map;
}
function stripLegacyBrackets(b: any): Preferences["bracket"] {
  const style: Preferences["bracket"]["style"] =
    ["none", "doubleCorner", "doubleAngle", "singleCorner", "singleAngle"].includes(b?.style) ? b.style : "none";
  return { enable: !!b?.enable, style };
}
function validateHex(s: string): string | null {
  const x = s?.trim();
  if (!x) return null;
  const m = x.match(/^#([0-9A-Fa-f]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : null;
}
function hexA(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
function clampN(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fallback;
}
function inferStyleFromName(fam: string): string | null {
  const n = fam.toLowerCase().replace(/\s+/g, "");

  // NEW: prefer combined styles when both "bold" and "italic/oblique" appear
  if (n.includes("bold") && (n.includes("italic") || n.includes("oblique"))) {
    return "Bold Italic";
  }

  const table: Array<[RegExp, string]> = [
    [/(?:^|[-_])(thin|hairline)/, "Thin"],
    [/(?:^|[-_])(extralight|ultralight)/, "ExtraLight"],
    [/(?:^|[-_])(light)/, "Light"],
    [/(?:^|[-_])(regular|book|normal)/, "Regular"],
    [/(?:^|[-_])(medium)/, "Medium"],
    [/(?:^|[-_])(semibold|demibold)/, "SemiBold"],
    [/(?:^|[-_])(bold)/, "Bold"],
    [/(?:^|[-_])(extrabold|ultrabold)/, "ExtraBold"],
    [/(?:^|[-_])(black|heavy)/, "Black"],
  ];
  for (const [re, label] of table) if (re.test(n)) return label;
  if (/(?:^|[-_])(italic|oblique)/.test(n)) return "Italic";
  return null;
}

function isTauri() {
  try {
    const w = window as any;
    return !!(w.__TAURI__ || w.__TAURI_INTERNALS__ || w.__TAURI_IPC__);
  } catch {
    return false;
  }
}

/** html / body / #root 에 동시에 테마 속성 적용 */
function applyThemeDom(theme: Preferences["theme"]) {
  try {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);

    const body = document.body;
    if (body) body.setAttribute("data-theme", theme);

    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.setAttribute("data-theme", theme);
  } catch {
    // ignore (초기 로딩 중일 수 있음)
  }
}

/** Override a subset of preferences from a SWON file.
 *  Overrides: autosave (+interval), typeface (4 slots), accentColor.
 *  Usage: setPrefs(p => overridePrefsFromSwon(p, swonPrefs));
 */
export function overridePrefsFromSwon(curr: Preferences, from: Partial<Preferences>): Preferences {
  const next: Preferences = { ...curr };
  if (typeof (from as any)?.autosave === "boolean") next.autosave = !!(from as any).autosave;
  if (typeof (from as any)?.autosaveIntervalSec === "number") {
    next.autosaveIntervalSec = clampN((from as any).autosaveIntervalSec, 10, 600, curr.autosaveIntervalSec);
  }
  if ((from as any)?.typeface) {
    const tf = (from as any).typeface;
    next.typeface = {
      headline: { ...next.typeface.headline, ...(tf.headline ?? {}) },
      body: { ...next.typeface.body, ...(tf.body ?? {}) },
      accent: { ...next.typeface.accent, ...(tf.accent ?? {}) },
      etc: { ...next.typeface.etc, ...(tf.etc ?? {}) },
    };
  }
  if ((from as any)?.accentColor) {
    next.accentColor = validateHex((from as any).accentColor) || next.accentColor;
  }
  return next;
}

// Reusable UI components
function Select({
  value,
  onChange,
  children,
  disabled,
  style,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="w-full rounded-lg border px-2 py-2 text-sm outline-none"
      style={{
        background: "var(--select-bg, rgba(255,255,255,0.05))",
        color: "var(--select-fg, #fff)",
        borderColor: "var(--select-border, rgba(255,255,255,0.10))",
        ...style,
      }}
    >
      {children}
    </select>
  );
}
const Option: React.FC<React.OptionHTMLAttributes<HTMLOptionElement>> = (p) => (
  <option
    {...p}
    style={{
      background: "var(--select-popup, #151518)",
      color: "var(--select-popup-fg, #fff)",
    }}
  />
);

function MonoInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { right?: React.ReactNode; accent: string }
) {
  const { right, className = "", accent: _accent, style, ...rest } = props;

  return (
    <div className="relative flex items-center">
      <input
        {...rest}
        className={`flex-1 rounded-lg px-3 py-2 text-sm outline-none placeholder:text-white/30 ${className}`}
        style={{
          background: "var(--input-bg, rgba(255,255,255,0.05))",
          border: "1px solid var(--input-border, rgba(255,255,255,0.10))",
          // focus 스타일은 전적으로 CSS(예: :focus-visible) 에 맡기고
          // 여기서는 더 이상 boxShadow / borderColor 를 조작하지 않는다.
          ...style,
        }}
      />
      {right && <div className="absolute right-2 text-xs text-white/40">{right}</div>}
    </div>
  );
}

function NumberInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { accent: string; width?: number }
) {
  const { accent: _accent, width = 96, style, ...rest } = props;

  return (
    <input
      {...rest}
      type="number"
      className="text-sm text-right rounded-lg px-2 py-2 outline-none"
      style={{
        width,
        background: "var(--input-bg, rgba(255,255,255,0.05))",
        border: "1px solid var(--input-border, rgba(255,255,255,0.10))",
        // 여기서도 focus 시 boxShadow / borderColor 조작 안 함
        ...style,
      }}
    />
  );
}

function useSystemFonts() {
  const [fonts, setFonts] = React.useState<FontDict>({});
  useEffect(() => {
    (async () => {
      if (!isTauri()) {
        setFonts(buildFallbackFonts());
        return;
      }
      try {
        try {
          // Try Rust list_fonts; if unavailable, fall back to scanning common font directories
          const list = await invoke<Array<{ name: string; styles: string[] }>>("list_fonts");
          if (Array.isArray(list) && list.length > 0) {
            const dict: FontDict = {};
            for (const f of list) dict[f.name] = new Set(f.styles?.length ? f.styles : [NONE_STYLE]);
            setFonts(dict);
            return;
          }
        } catch (e) {
          console.warn("[fonts] rust list_fonts failed, fallback to dir scan", e);
        }

        const pf = await platform();
        const home = await homeDir();
        const dirs: string[] = [];
        if (pf === "darwin") {
          dirs.push("/System/Library/Fonts", "/Library/Fonts", `${home}Library/Fonts`);
        } else if (pf === "win32") {
          const homeNorm = String(home).replace(/\\/g, "/");
          dirs.push("C:/Windows/Fonts", `${homeNorm}AppData/Local/Microsoft/Windows/Fonts`);
        } else {
          dirs.push("/usr/share/fonts", "/usr/local/share/fonts", `${home}.fonts`);
        }

        const found: FontDict = {};
        for (const dir of dirs) {
          try {
            const safeDir = dir.replace(/\\/g, "/");
            const entries = await readDir(safeDir, { recursive: true });
            for (const e of entries) collectFonts(e, found);
          } catch (err) {
            console.warn("[fonts] scan failed:", dir, err);
          }
        }
        if (Object.keys(found).length < 4) {
          const fb = buildFallbackFonts();
          for (const fam of Object.keys(fb)) {
            if (!found[fam]) found[fam] = new Set();
            fb[fam].forEach((s) => found[fam].add(s));
          }
        }
        setFonts(found);
      } catch (err) {
        console.error("[fonts] unexpected error:", err);
        setFonts(buildFallbackFonts());
      }
    })();
  }, []);
  return fonts;
}

function collectFonts(entry: any, dict: FontDict) {
  if (entry.children) {
    entry.children.forEach((c: any) => collectFonts(c, dict));
    return;
  }
  const name: string = entry.name || "";
  if (!/\.(ttf|otf|ttc|otc)$/i.test(name)) return;
  const base = name.replace(/\.(ttf|otf|ttc|otc)$/i, "");
  let fam = base,
    style = "Regular";
  const dash = base.lastIndexOf("-");
  if (dash > 0) {
    fam = base.slice(0, dash);
    style = base.slice(dash + 1);
  }
  fam = fam.replace(/_/g, " ");
  style = style.replace(/_/g, " ");
  if (!dict[fam]) dict[fam] = new Set();
  dict[fam].add(style);
}

export function PreferenceModal({
  prefs,
  onChange,
  onClose,
}: {
  prefs: Preferences;
  onChange: (next: Preferences) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Also push CSS immediately for live preview (effect above covers normal updates)
    installPresetCSS({
      headline: prefs.typeface.headline,
      body: prefs.typeface.body,
      accent: prefs.typeface.accent,
      etc: prefs.typeface.etc,
    });
  }, [prefs.typeface]);

  const [presetOpen, setPresetOpen] = React.useState(false);
  const [presetItems, setPresetItems] = React.useState<string[]>([]);
  const presetBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const presetMenuRef = React.useRef<HTMLDivElement | null>(null);

  const [nameDlg, setNameDlg] = React.useState<{ open: boolean; value: string }>({
    open: false,
    value: "",
  });

  useEffect(() => {
    if (!presetOpen) return;
    const onPointerDown = (e: Event) => {
      const t = e.target as Node;
      if (presetMenuRef.current?.contains(t)) return;
      if (presetBtnRef.current?.contains(t)) return;
      setPresetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresetOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [presetOpen]);

  function toUserPreset(p: Preferences) {
    return {
      workingFolder: p.workingFolder,
      autosave: p.autosave,
      autosaveIntervalSec: p.autosaveIntervalSec,
      typeface: p.typeface,
      accentColor: p.accentColor,
      writingGoal: p.writingGoal,
      bracket: p.bracket,
      theme: p.theme,
    };
  }

  // Modal dialog for naming and saving user presets
  function NamePresetDialog({
    open,
    initial = "",
    onCancel,
    onSubmit,
  }: {
    open: boolean;
    initial?: string;
    onCancel: () => void;
    onSubmit: (name: string) => void;
  }) {
    const [name, setName] = React.useState(initial);
    useEffect(() => {
      setName(initial || "");
    }, [initial, open]);
    if (!open) return null;

    const onEnter: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
      if (e.key === "Enter") onSubmit(name);
      if (e.key === "Escape") onCancel();
    };

    return (
      <div className="fixed inset-0 z-[999]" onMouseDown={onCancel}>
        <div className="absolute inset-0 bg-black/60" />
        <div className="absolute inset-0 flex items-center justify-center p-4" onMouseDown={(e) => e.stopPropagation()}>
          <div
            className="w-[420px] max-w-[90vw] rounded-2xl border shadow-2xl overflow-hidden"
            style={{
              background: "var(--panel-bg)",
              color: "var(--prefs-text-main)",
              borderColor: "var(--border)",
            }}
          >
            <div
              className="px-4 py-3 border-b text-[15px] font-medium"
              style={{
                borderColor: "var(--divider)",
                color: "var(--titlebar-text)",
              }}
            >
              Save preset
            </div>
            <div className="p-4 space-y-3">
              <label className="text-xs text-white/60 block">Preset name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onEnter}
                placeholder="e.g. My Writing Set"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none"
              />
              <div className="text-[11px] text-white/40">
                The preset will include: Working Folder, Autosave(+Interval), Typeface v4,
                Accent Color, Writing Goal, Curly Braces, Theme.
              </div>
            </div>
            <div className="px-4 py-3 border-t border-white/10 flex justify-end gap-2">
              <button
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs border border-white/10"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 rounded-lg text-xs border"
                style={{
                  background: "color-mix(in srgb, var(--accent) 24%, transparent)",
                  borderColor: "var(--accent)",
                }}
                onClick={() => onSubmit(name)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function openPresetMenu() {
    try {
      setPresetItems(await listPresets());
    } catch {}
    setPresetOpen((v) => !v);
  }
  async function handleLoadPreset(name: string) {
    const data = await loadPreset(name);
    if (!data) {
      alert("Failed to load preset.");
      return;
    }
    const merged = { ...(prefs as any), ...(data as any) } as Preferences;
    merged.typeface = normalizeTypeface(merged.typeface);

    // 프리셋에 저장된 Theme / Accent 를 즉시 DOM에 반영
    applyThemeDom(merged.theme);
    applyAccentTokens(validateHex(merged.accentColor) || FALLBACK_ACCENT);

    onChange(merged);
    setPresetOpen(false);
  }
  async function handleSavePreset() {
    setNameDlg({ open: true, value: "" });
  }

  async function doSavePreset(name: string) {
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    // Check name collision and prompt for overwrite
    let exists = false;
    try {
      const all = await listPresets();
      exists = Array.isArray(all) && all.includes(trimmed);
    } catch {}

    if (exists) {
      const ok = window.confirm(`Preset "${trimmed}" already exists.\nOverwrite it?`);
      if (!ok) return;
    }

    await savePreset(trimmed, toUserPreset(prefs) as any);
    try {
      setPresetItems(await listPresets());
    } catch {}
    alert("Saved.");
    setPresetOpen(false);
    setNameDlg({ open: false, value: "" });
  }

  async function handleApplyDefault() {
    const base = await applyDefault();
    const merged = { ...(prefs as any), ...(base as any) } as Preferences;
    merged.typeface = normalizeTypeface(merged.typeface);

    // 공장 초기화:
    //  - Dark 테마 + 기본 값으로 되돌리고
    //  - workingFolder 는 비워서 안전하게
    //  - Theme / Accent 토큰을 즉시 DOM에 반영
    const next: Preferences = {
      ...(merged as Preferences),
      workingFolder: "",
    };

    applyThemeDom(next.theme);
    applyAccentTokens(validateHex(next.accentColor) || FALLBACK_ACCENT);

    set(next);
    setPresetOpen(false);
  }

  const t = useMemo(() => {
    const lang = String((prefs as any).language);
    return (lang in STRINGS ? (STRINGS as any)[lang] : STRINGS.en) as (typeof STRINGS)[LangKey];
  }, [prefs.language]);

  const set = (patch: Partial<Preferences>) => {
    // 이 호출에서 workingFolder 를 건드리면,
    // 다음 한 번의 setPrefs 에서는 가드를 건너뛰게 플래그를 켠다.
    if (typeof patch.workingFolder === "string") {
      nextWorkingFolderChangeFromUI = true;
    }
    onChange({ ...prefs, ...patch });
  };

  const setTF = (k: keyof Preferences["typeface"], patch: Partial<FontTriplet>) => {
    const next = { ...prefs.typeface, [k]: { ...prefs.typeface[k], ...patch } };
    set({ typeface: next });
    installPresetCSS({
      headline: next.headline,
      body: next.body,
      accent: next.accent,
      etc: next.etc,
    });
  };
  const setBracket = (patch: Partial<Preferences["bracket"]>) => set({ bracket: { ...prefs.bracket, ...patch } });

  const interval = Math.max(10, Math.min(600, Number(prefs.autosaveIntervalSec) || 10));
  const autosaveOptions = useMemo(() => {
    const set = new Set<number>(AUTOSAVE_INTERVAL_CHOICES);
    set.add(interval);
    return Array.from(set).sort((a, b) => a - b);
  }, [interval]);

  const ACC = validateHex(prefs.accentColor) || FALLBACK_ACCENT;

  // Writing Goal target 편한 입력용 draft (문자열)
  const [goalTargetDraft, setGoalTargetDraft] = React.useState<string>(
    () => String(prefs.writingGoal.target)
  );

  // prefs.writingGoal.target 이 바뀌면 draft도 동기화
  useEffect(() => {
    setGoalTargetDraft(String(prefs.writingGoal.target));
  }, [prefs.writingGoal.target]);

  const sysFonts = useSystemFonts();
  const families = useMemo(() => Object.keys(sysFonts).sort((a, b) => a.localeCompare(b)), [sysFonts]);
  const stylesFor = (fam: string) => {
    const famSet = sysFonts[fam];
    if (!famSet || famSet.size === 0) return [NONE_STYLE];
    return Array.from(famSet).sort((a, b) => a.localeCompare(b));
  };

  useEffect(() => {
    const r = document.documentElement;

    if (prefs.theme === "dark") {
      r.style.setProperty("--select-bg", "rgba(255,255,255,0.05)");
      r.style.setProperty("--select-fg", "#f9fafb");
      r.style.setProperty("--select-border", "rgba(255,255,255,0.16)");
      r.style.setProperty("--select-popup", "#151518");
      r.style.setProperty("--select-popup-fg", "#f9fafb");
    } else {
      // light
      r.style.setProperty("--select-bg", "rgba(255,255,255,0.90)");
      r.style.setProperty("--select-fg", "#111827");
      r.style.setProperty("--select-border", "rgba(15,23,42,0.16)");
      r.style.setProperty("--select-popup", "#f9fafb");
      r.style.setProperty("--select-popup-fg", "#111827");
    }
  }, [prefs.theme]);

  const CONTENT_W = 740;
  const sharedMax = { width: `min(100%, ${CONTENT_W}px)` } as React.CSSProperties;

  const onBrowseWorkingFolder = async () => {
    if (!isTauri()) {
      alert("This action is available in the Tauri app.");
      return;
    }
    try {
      const picked = await openDialog({
        title: "Choose a working folder for Splitwriter",
        directory: true,
        multiple: false,
        defaultPath: prefs.workingFolder || undefined,
      });
      const abs =
        typeof picked === "string"
          ? picked
          : Array.isArray(picked) && picked.length > 0 && typeof picked[0] === "string"
          ? picked[0]
          : null;
      if (abs) set({ workingFolder: abs });
    } catch (err) {
      console.error("Folder picking failed:", err);
      alert("Failed to open folder picker.");
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div
            className="w-[880px] max-w-[95vw] rounded-2xl border shadow-2xl overflow-hidden"
            style={{
              maxHeight: "min(92vh, 1080px)",
              background: "var(--panel-bg)",
              color: "var(--prefs-text-main)",
              borderColor: "var(--border)",
            }}
          >
            {/* ---------- Header ---------- */}
            <div
              className="flex items-center justify-between px-5 py-3 border-b"
              style={{ borderColor: "var(--divider)" }}
            >
              <div className="flex items-center gap-3">
                <div className="text-[15px] font-medium tracking-wide truncate">
                  {t.title}
                </div>

                {/* Theme toggle */}
                <div
                  className="flex items-center gap-2 text-xs"
                  style={{ color: "var(--prefs-text-sub)" }}
                >
                  <span className="opacity-80">{t.theme}</span>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={prefs.theme === "dark"}
                    onClick={() => {
                      const nextTheme = prefs.theme === "dark" ? "light" : "dark";
                      set({ theme: nextTheme });
                      // html/body/#root 에 모두 적용
                      applyThemeDom(nextTheme);
                    }}
                    className="relative inline-flex h-5 w-9 items-center rounded-full border transition-colors duration-150"
                    style={{
                      backgroundColor:
                        prefs.theme === "dark"
                          ? "rgba(255,255,255,0.10)"
                          : "rgba(0,0,0,0.05)",
                      borderColor:
                        prefs.theme === "dark"
                          ? "rgba(255,255,255,0.30)"
                          : "rgba(0,0,0,0.18)",
                    }}
                    title={`${t.dark}/${t.light}`}
                  >
                    <span
                      className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full bg-white shadow transition-[left] duration-150"
                      style={{ left: prefs.theme === "dark" ? 18 : 4 }}
                    />
                  </button>

                  <span className="text-xs ml-1">
                    {prefs.theme === "dark" ? t.dark : t.light}
                  </span>
                </div>
              </div>

              <div className="relative flex items-center gap-2">
                <button
                  ref={presetBtnRef}
                  className="w-[96px] py-1.5 rounded-lg text-xs border text-center"
                  style={{
                    background: "var(--btn-bg)",
                    borderColor: "var(--border)",
                    color: "var(--text-1)",
                  }}
                  onClick={openPresetMenu}
                  title="Presets"
                >
                  Presets ▾
                </button>

                {presetOpen && (
                  <div
                    ref={presetMenuRef}
                    className="absolute right-0 top-full mt-2 w-60 rounded-lg border shadow-xl z-50"
                    style={{
                      background: "var(--panel)",
                      borderColor: "var(--border)",
                      color: "var(--text-1)",
                    }}
                  >
                    <div className="py-1 text-xs">
                      <div className="px-3 py-1.5 opacity-60">Load preset</div>
                      {presetItems.length === 0 ? (
                        <div className="px-3 py-1.5 opacity-60">No presets</div>
                      ) : (
                        presetItems.slice(0, 10).map((name) => (
                          <button
                            key={name}
                            className="w-full text-left px-3 py-1.5 hover:bg-[rgba(255,255,255,0.06)]"
                            onClick={() => handleLoadPreset(name)}
                          >
                            {name}
                          </button>
                        ))
                      )}
                      <div
                        className="my-1 border-t"
                        style={{ borderColor: "var(--divider, rgba(158,162,170,.18))" }}
                      />
                      <button
                        className="w-full text-left px-3 py-1.5 hover:bg-[rgba(255,255,255,0.06)]"
                        onClick={handleSavePreset}
                      >
                        Save preset…
                      </button>
                      <button
                        className="w-full text-left px-3 py-1.5 hover:bg-[rgba(255,255,255,0.06)]"
                        onClick={handleApplyDefault}
                      >
                        Default preset
                      </button>
                      <div
                        className="my-1 border-t"
                        style={{ borderColor: "var(--divider, rgba(158,162,170,.18))" }}
                      />
                      <button
                        className="w-full text-left px-3 py-1.5 hover:bg-[rgba(255,255,255,0.06)]"
                        onClick={async () => {
                          await revealPresetFolder();
                          setPresetOpen(false);
                        }}
                      >
                        Open presets folder
                      </button>
                    </div>
                  </div>
                )}

                <button
                  className="text-sm px-2 py-1 rounded-md hover:bg-[rgba(255,255,255,0.06)]"
                  style={{ color: "var(--text-2)" }}
                  onClick={onClose}
                  aria-label={t.close}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* ---------- Body ---------- */}
            <div
              className="p-5 space-y-6 overflow-y-auto"
              style={{
                maxHeight: "calc(min(92vh,1080px) - 96px)",
                color: "var(--prefs-text-main)",
              }}
            >
              {/* Working Folder */}
              <section className="space-y-2 mx-auto" style={sharedMax}>
                <label className="flex items-center gap-2 text-sm">
                  <IcFolder className="opacity-80" />
                  <span>{t.workingFolder}</span>
                </label>
                <p className="text-xs" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                  {t.workingFolderHint}
                </p>
                <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                  <MonoInput
                    placeholder="/Users/you/Documents/splitwriter"
                    value={prefs.workingFolder}
                    onChange={(e) => set({ workingFolder: e.target.value })}
                    accent={ACC}
                    className="w-full"
                  />
                  <button
                    className="px-3 py-2 rounded-lg text-xs border"
                    style={{
                      background: "var(--btn-bg)",
                      borderColor: hexA(ACC, 0.45),
                      color: "var(--text-1)",
                    }}
                    onClick={onBrowseWorkingFolder}
                  >
                    {t.browse}
                  </button>
                </div>
              </section>

              <hr className="border-t" style={{ borderColor: "var(--divider)" }} />

              {/* Autosave toggle */}
              <section className="grid grid-cols-[1fr_auto] items-center gap-3 mx-auto" style={sharedMax}>
                <div>
                  <label className="flex items-center gap-2 text-sm">
                    <IcClock className="opacity-80" />
                    <span>{t.autosave}</span>
                  </label>
                  <p className="text-xs mt-1" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                    {t.autosaveDesc}
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={prefs.autosave}
                  onClick={() => set({ autosave: !prefs.autosave })}
                  className="relative h-6 w-12 rounded-full border transition-colors"
                  style={{
                    backgroundColor: prefs.autosave ? hexA(ACC, 0.25) : "rgba(255,255,255,0.05)",
                    borderColor: prefs.autosave ? hexA(ACC, 0.4) : "rgba(255,255,255,0.15)",
                  }}
                  title={prefs.autosave ? "ON" : "OFF"}
                >
                  <span
                    className="absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-white shadow transition-[left]"
                    style={{ left: prefs.autosave ? 28 : 4 }}
                  />
                </button>
              </section>

              {/* Autosave Interval */}
              <section className="grid grid-cols-[1fr_auto] items-center gap-3 mx-auto" style={sharedMax}>
                <div>
                  <label className="text-sm">{t.autosaveInterval}</label>
                  <p className="text-xs mt-1" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                    {t.autosaveRange}
                  </p>
                </div>
                <Select
                  value={String(interval)}
                  onChange={(e) => {
                    const n = Math.max(10, Math.min(600, Number(e.target.value) || 10));
                    set({ autosaveIntervalSec: n });
                  }}
                  disabled={!prefs.autosave}
                  style={{ width: 140 }}
                >
                  {autosaveOptions.map((sec) => {
                    const label = sec < 60 ? `${sec} sec` : `${sec / 60} min`;
                    return (
                      <Option key={sec} value={String(sec)}>
                        {label}
                      </Option>
                    );
                  })}
                </Select>
              </section>

              <hr className="border-t" style={{ borderColor: "var(--divider)" }} />

              {/* Typeface Presets */}
              <section className="space-y-2 mx-auto" style={sharedMax}>
                <label className="flex items-center gap-2 text-sm">
                  <IcA className="opacity-80" />
                  <span>{t.fonts}</span>
                </label>
                <p className="text-xs" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                  {t.fontsHint}
                </p>

                {(["headline", "body", "accent", "etc"] as const).map((key) => {
                  const label =
                    key === "headline" ? t.headline : key === "body" ? t.body : key === "accent" ? t.accent : t.etc;
                  const triplet = prefs.typeface[key];
                  const styles = stylesFor(triplet.name);

                  return (
                    <div
                      key={key}
                      className="grid grid-cols-[96px_280px_220px_120px] items-center gap-2"
                    >
                      <div className="text-xs" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                        {label}
                      </div>

                      <Select
                        value={triplet.name}
                        onChange={(e) => {
                          const fam = e.target.value;
                          const candidates = stylesFor(fam);
                          const inferred = inferStyleFromName(fam);
                          const nextStyle =
                            candidates.length === 1 && candidates[0] === NONE_STYLE
                              ? NONE_STYLE
                              : inferred && candidates.includes(inferred)
                              ? inferred
                              : candidates.includes(triplet.style)
                              ? triplet.style
                              : candidates[0] || "Regular";
                          setTF(key, { name: fam, style: nextStyle });
                        }}
                      >
                        <Option value={SYSTEM_STACK}>{SYSTEM_LABEL}</Option>
                        {families.map((fam) => (
                          <Option key={fam} value={fam}>
                            {fam}
                          </Option>
                        ))}
                      </Select>

                      <Select
                        value={triplet.style}
                        onChange={(e) => setTF(key, { style: e.target.value })}
                        disabled={styles.length === 1 && styles[0] === NONE_STYLE}
                        title={styles.length === 1 && styles[0] === NONE_STYLE ? "No style variants" : undefined}
                      >
                        {styles.length === 1 && styles[0] === NONE_STYLE ? (
                          <Option value={NONE_STYLE}>{NONE_STYLE}</Option>
                        ) : (
                          styles.map((st) => (
                            <Option
                              key={st}
                              value={st}
                              title={`${triplet.name.replace(/\s+/g, "_")}_${st.replace(/\s+/g, "_")}`}
                            >
                              {st}
                            </Option>
                          ))
                        )}
                      </Select>

                      <NumberInput
                        accent={ACC}
                        width={120}
                        value={triplet.size}
                        min={8}
                        max={96}
                        onChange={(e) =>
                          setTF(key, {
                            size: clampN(e.target.value, 8, 96, triplet.size),
                          })
                        }
                      />
                    </div>
                  );
                })}

                {/* Typeface preview */}
                <div
                  className="mt-2 rounded-lg border px-3 py-3 text-sm"
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    borderColor: "var(--border)",
                  }}
                >
                  <div className="grid grid-cols-1 gap-2">
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                        {t.preview} — Headline
                      </div>
                      <div
                        style={{
                          fontFamily: prefs.typeface.headline.name,
                          fontSize: prefs.typeface.headline.size,
                          fontWeight: weightFromStyle(prefs.typeface.headline.style),
                        }}
                      >
                        The quick brown fox jumps over the lazy dog.
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                        {t.preview} — Body
                      </div>
                      <div
                        style={{
                          fontFamily: prefs.typeface.body.name,
                          fontSize: prefs.typeface.body.size,
                          fontWeight: weightFromStyle(prefs.typeface.body.style),
                        }}
                      >
                        Sphinx of black quartz, judge my vow.
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                        {t.preview} — Accent
                      </div>
                      <div
                        style={{
                          fontFamily: prefs.typeface.accent.name,
                          fontSize: prefs.typeface.accent.size,
                          fontWeight: weightFromStyle(prefs.typeface.accent.style),
                          color: ACC,
                        }}
                      >
                        Pack my box with five dozen liquor jugs.
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                        {t.preview} — Etc
                      </div>
                      <div
                        style={{
                          fontFamily: prefs.typeface.etc.name,
                          fontSize: prefs.typeface.etc.size,
                          fontWeight: weightFromStyle(prefs.typeface.etc.style),
                          opacity: 0.85,
                        }}
                      >
                        (Etc) Waltz, bad nymph, for quick jigs vex.
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <hr className="border-t" style={{ borderColor: "var(--divider)" }} />

              {/* Accent color */}
              <section className="space-y-2 mx-auto" style={sharedMax}>
                <label className="flex items-center gap-2 text-sm">
                  <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: ACC }} />
                  <span>{t.accentColor}</span>
                </label>
                <p className="text-xs" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                  {t.accentDesc}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="color"
                    value={ACC}
                    onChange={(e) => set({ accentColor: validateHex(e.target.value) || FALLBACK_ACCENT })}
                    className="h-9 w-12 p-0 bg-transparent border rounded"
                    style={{ borderColor: "var(--border)" }}
                    title="Pick accent color"
                  />
                  <MonoInput
                    placeholder="#2AA4FF"
                    value={ACC}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const v = validateHex(raw);
                      if (v) set({ accentColor: v });
                    }}
                    accent={ACC}
                    className="w-44"
                  />
                </div>
              </section>

              <hr className="border-t" style={{ borderColor: "var(--divider)" }} />

              {/* Writing goal */}
              <section className="space-y-2 mx-auto" style={sharedMax}>
                <label className="flex items-center gap-2 text-sm">
                  {/* 여기 span만 교체 */}
                  <span
                    className="inline-block w-3 h-3 rounded"
                    style={{
                      backgroundColor: hexA(ACC, 0.75),           // 액센트 기반 부드러운 점
                      boxShadow: `0 0 0 1px ${hexA(ACC, 0.40)}`,  // 살짝 테두리 줘서 배경에서 안 묻히게
                    }}
                  />
                  <span>{t.goalTitle}</span>
                </label>
                <p
                  className="text-xs"
                  style={{ color: "var(--prefs-text-sub, var(--text-2))" }}
                >
                  {t.goalDesc}
                </p>

                <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 items-center">
                  <span className="text-sm">{t.goalEnable}</span>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-white"
                      checked={prefs.writingGoal.enabled}
                      onChange={(e) =>
                        set({ writingGoal: { ...prefs.writingGoal, enabled: e.target.checked } })
                      }
                    />
                    <span className="text-sm" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                      {prefs.writingGoal.enabled ? "ON" : "OFF"}
                    </span>
                  </label>

                  <span className="text-sm">{t.goalUnit}</span>
                  <Select
                    value={prefs.writingGoal.unit}
                    onChange={(e) =>
                      set({ writingGoal: { ...prefs.writingGoal, unit: e.target.value as any } })
                    }
                    disabled={!prefs.writingGoal.enabled}
                  >
                    <Option value="chars">{t.unitChars}</Option>
                    <Option value="words">{t.unitWords}</Option>
                  </Select>

                  <span className="text-sm">{t.goalTarget}</span>
                  <NumberInput
                    accent={ACC}
                    min={1}
                    max={1_000_000}
                    value={goalTargetDraft}
                    onChange={(e) => {
                      // 타이핑 중에는 그냥 문자열 상태만 바꿔서
                      // Backspace / Delete 해도 1로 튀지 않게
                      setGoalTargetDraft(e.target.value);
                    }}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();

                      // 완전히 비워두고 나가면, 기존 값으로 되돌려줌
                      if (!raw) {
                        setGoalTargetDraft(String(prefs.writingGoal.target));
                        return;
                      }

                      // 숫자로 파싱 + 범위 클램프 (1 ~ 1,000,000)
                      const clamped = clampN(
                        raw,
                        1,
                        1_000_000,
                        prefs.writingGoal.target
                      );

                      // prefs 에 확정 저장 + draft 재동기화
                      set({
                        writingGoal: {
                          ...prefs.writingGoal,
                          target: clamped,
                        },
                      });
                      setGoalTargetDraft(String(clamped));
                    }}
                    disabled={!prefs.writingGoal.enabled}
                    width={120}
                  />

                  <span className="text-sm">{t.goalPreview}</span>
                  <div className="text-sm">
                    <span
                      style={{
                        color: ACC,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      900
                    </span>
                    <span className="mx-1" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                      /
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {prefs.writingGoal.target.toLocaleString()}
                    </span>
                    <span
                      className="ml-2"
                      style={{ color: "var(--prefs-text-sub, var(--text-2))" }}
                    >
                      {prefs.writingGoal.unit === "chars"
                        ? t.unitChars.toLowerCase()
                        : t.unitWords.toLowerCase()}
                    </span>
                  </div>
                </div>
              </section>

              <hr className="border-t" style={{ borderColor: "var(--divider)" }} />

              {/* Curly bracket replacement */}
              <section className="space-y-2 mx-auto" style={sharedMax}>
                <label className="flex items-center gap-2 text-sm">
                  <img src={curlyIconUrl} alt="{ }" width={16} height={16} className="sw-icon opacity-80" />
                  <span>{t.bracket}</span>
                </label>
                <p className="text-xs" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                  {t.bracketDesc}
                </p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 select-none">
                    <input
                      type="checkbox"
                      className="accent-white"
                      checked={prefs.bracket.enable}
                      onChange={(e) => setBracket({ enable: e.target.checked })}
                    />
                    <span className="text-sm">{t.enable}</span>
                  </label>
                  <Select
                    value={prefs.bracket.style}
                    onChange={(e) =>
                      setBracket({ style: e.target.value as Preferences["bracket"]["style"] })
                    }
                    disabled={!prefs.bracket.enable}
                  >
                    <Option value="none">{t.none}</Option>
                    <Option value="doubleCorner">{t.doubleCorner}</Option>
                    <Option value="doubleAngle">{t.doubleAngle}</Option>
                    <Option value="singleCorner">{t.singleCorner}</Option>
                    <Option value="singleAngle">{t.singleAngle}</Option>
                  </Select>
                </div>
                <div className="text-xs mt-1" style={{ color: "var(--prefs-text-sub, var(--text-2))" }}>
                  {t.preview}:
                  <code className="px-1 py-0.5 rounded bg-white/5">{`{`}</code>
                  content
                  <code className="px-1 py-0.5 rounded bg-white/5">{`}`}</code>
                  <span className="mx-1 opacity-60">→</span>
                  <span style={{ color: ACC }}>{BRACKET_MAP[prefs.bracket.style][0]}</span>
                  content
                  <span style={{ color: ACC }}>{BRACKET_MAP[prefs.bracket.style][1]}</span>
                </div>
              </section>

              {/* Preset name dialog */}
              <NamePresetDialog
                open={nameDlg.open}
                initial={nameDlg.value}
                onCancel={() => setNameDlg({ open: false, value: "" })}
                onSubmit={(n) => doSavePreset(n)}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function weightFromStyle(style: string | undefined) {
  if (!style) return 400;
  const s = style.toLowerCase();
  if (s === "(none)") return 400;
  if (s.includes("thin")) return 100;
  if (s.includes("extralight") || s.includes("ultralight")) return 200;
  if (s.includes("light")) return 300;
  if (s.includes("regular") || s.includes("normal") || s === "") return 400;
  if (s.includes("medium")) return 500;
  if (s.includes("semibold") || s.includes("demibold")) return 600;
  if (s.includes("bold")) return 700;
  if (s.includes("extrabold") || s.includes("ultrabold")) return 800;
  if (s.includes("black") || s.includes("heavy")) return 900;
  return 400;
}

export default PreferenceModal;
