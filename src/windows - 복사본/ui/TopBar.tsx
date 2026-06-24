// src/windows/ui/TopBar.tsx
import React, { useEffect } from "react";

// Bundle-safe asset URLs (Vite/Tauri)
const SIDEBAR_ICON = new URL("../icons/Sidebar.png", import.meta.url).href;
const PREFS_ICON   = new URL("../icons/Preferences.png", import.meta.url).href;

export type TopBarProps = {
  activePreset: number;                 // 1~4 (H/B/A/E)
  onPresetClick: (n: number) => void;   // H/B/A/E 클릭(또는 단축키) 시 알림
  onToggleSidebar: () => void;
  onOpenAbout: () => void;
  onOpenPreferences: () => void;
  accentColor?: string;
};

const BAR_H   = 32;
const BTN_WH  = 26;      // compact
const ICON_WH = 16;

const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { src?: string; alt: string; label?: string }
> = ({ src, alt, label, style, className, ...rest }) => (
  <button
    {...rest}
    title={alt}
    className={`tb-iconbtn ${className ?? ""}`.trim()} 
    style={{
      display: "grid",
      placeItems: "center",
      width: BTN_WH,
      height: BTN_WH,
      borderRadius: 4,
      background: "transparent",
      border: "1px solid var(--border)", 
      padding: 0,
      cursor: "pointer",
      userSelect: "none",
      // hover 배경은 index.css의 .tb-iconbtn:hover가 처리
      ...style,
    }}
  >
    {src ? (
      // 아이콘 톤/호버는 index.css(.tb-iconbtn img / :hover img)에서 제어
      <img src={src} alt={alt} width={ICON_WH} height={ICON_WH} style={{ display: "block" }} draggable={false} />
    ) : (
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1, marginTop: -1, opacity: .9 }}>
        {label ?? "..."}
      </span>
    )}
  </button>
);

function pickAccent(manual?: string) {
  const hex = (s?: string) => (s || "").toString().trim();
  if (manual && hex(manual)) return manual;
  const root = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  if (hex(root)) return root.trim();
  const body = getComputedStyle(document.body).getPropertyValue("--accent");
  if (hex(body)) return body.trim();
  return "#6aa8ff";
}
function alpha(c: string, a: number) {
  let r = 106, g = 168, b = 255;
  if (c.startsWith("rgb")) {
    const nums = c.replace(/[^\d.,]/g, "").split(",").map(Number);
    [r, g, b] = nums as any;
  } else {
    let s = c.replace("#", "").trim();
    if (s.length === 3) s = s.split("").map((ch) => ch + ch).join("");
    if (s.length === 6) {
      r = parseInt(s.slice(0, 2), 16);
      g = parseInt(s.slice(2, 4), 16);
      b = parseInt(s.slice(4, 6), 16);
    }
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function PresetIndicator({ preset, accent }: { preset: number; accent: string }) {
  const p = Math.min(4, Math.max(1, Math.round(preset || 1)));
  const items = [
    { k: 1, label: "H" },
    { k: 2, label: "B" },
    { k: 3, label: "A" },
    { k: 4, label: "E" },
  ];
  return (
    <div
      aria-label="Current preset"
      style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 8, letterSpacing: 1, userSelect: "none" }}
    >
      {items.map((it, i) => {
        const active = p === it.k;
        return (
          <React.Fragment key={it.k}>
            <span
              style={{
                color: active ? accent : "var(--text-2)",              // ← 토큰
                fontWeight: active ? 800 : 600,
                textShadow: active ? `0 0 10px ${alpha(accent, 0.4)}` : "none",
              }}
            >
              {it.label}
            </span>
            {i < items.length - 1 && <span style={{ color: "rgba(231,234,238,0.30)" }}>/</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

const TopBar: React.FC<TopBarProps> = ({
  activePreset,
  onPresetClick,
  onToggleSidebar,
  onOpenAbout,
  onOpenPreferences,
  accentColor,
}) => {
  // --- HUD 구독 & 초기 preset 동기화 (컴포넌트 내부!) ---
  const [hud, setHud] = React.useState<{ preset: 1|2|3|4; bold: boolean; italic: boolean }>({
    preset: (Math.min(4, Math.max(1, Math.round(activePreset))) as 1|2|3|4) || 2,
    bold: false,
    italic: false,
  });

  // props.activePreset이 바뀌면 HUD도 맞춰줌
  useEffect(() => {
    setHud(h => ({ ...h, preset: (Math.min(4, Math.max(1, Math.round(activePreset))) as 1|2|3|4) }));
  }, [activePreset]);

  // TextBoard가 broadcast하는 sw:hud 이벤트 구독
  useEffect(() => {
    const onHud = (ev: Event) => {
      const e = ev as CustomEvent<{ preset?: 1|2|3|4; bold?: boolean; italic?: boolean }>;
      if (e.detail) setHud(prev => ({ ...prev, ...e.detail }));
    };
    window.addEventListener('sw:hud', onHud as any);
    return () => window.removeEventListener('sw:hud', onHud as any);
  }, []);

  // ─────────────────────────────
  // Status (persist-until-typing)
  // ─────────────────────────────
  const [status, setStatus] = React.useState("");
  const hasStatusRef = React.useRef(false);

  const hideStatus = React.useCallback(() => {
    hasStatusRef.current = false;
    setStatus("");
  }, []);

  useEffect(() => {
    const onStatus = (ev: Event) => {
      const { text = "" } = (ev as CustomEvent).detail || {};
      if (!text) return;
      hasStatusRef.current = true;
      setStatus(text);
    };
    window.addEventListener("sw:status", onStatus as any, { capture: true });
    return () => {
      window.removeEventListener("sw:status", onStatus as any, { capture: true });
      hideStatus();
    };
  }, [hideStatus]);

  useEffect(() => {
    const inEditor = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest?.('[data-board-id] [contenteditable="true"], textarea, input');

    const clearIfTyping = (e: Event) => {
      if (hasStatusRef.current && inEditor(e.target)) hideStatus();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasStatusRef.current || !inEditor(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ignore = new Set([
        "Shift","Control","Alt","Meta","CapsLock","Tab","Escape",
        "ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown","Insert","ContextMenu"
      ]);
      if (!ignore.has(e.key)) hideStatus();
    };

    window.addEventListener("input", clearIfTyping, { capture: true });
    window.addEventListener("compositionend", clearIfTyping as any, { capture: true });
    window.addEventListener("keydown", onKeyDown as any, { capture: true });
    return () => {
      window.removeEventListener("input", clearIfTyping, { capture: true });
      window.removeEventListener("compositionend", clearIfTyping as any, { capture: true });
      window.removeEventListener("keydown", onKeyDown as any, { capture: true });
    };
  }, [hideStatus]);

  useEffect(() => {
    const dbg = (ev: Event) => {
      const d = (ev as CustomEvent).detail || {};
      console.log("[sw:status]", new Date().toISOString(), d.text, "ttl=", d.ttl, "level=", d.level);
    };
    if ((window as any).__DEBUG_STATUS__) {
      window.addEventListener("sw:status", dbg as any, { capture: true });
      return () => window.removeEventListener("sw:status", dbg as any, { capture: true });
    }
  }, []);

  useEffect(() => {
    const inEditor = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest?.('[contenteditable="true"], textarea, input');

    const clearIfTyping = (e: Event) => {
      if (hasStatusRef.current && inEditor(e.target)) hideStatus();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasStatusRef.current || !inEditor(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ignore = new Set([
        "Shift","Control","Alt","Meta","CapsLock","Tab","Escape",
        "ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End",
        "PageUp","PageDown","Insert","ContextMenu"
      ]);
      if (!ignore.has(e.key)) hideStatus();
    };

    window.addEventListener("input", clearIfTyping, { capture: true });
    window.addEventListener("compositionend", clearIfTyping as any, { capture: true });
    window.addEventListener("pointerdown", clearIfTyping as any, { capture: true });
    window.addEventListener("keydown", onKeyDown as any, { capture: true });

    return () => {
      window.removeEventListener("input", clearIfTyping, { capture: true });
      window.removeEventListener("compositionend", clearIfTyping as any, { capture: true });
      window.removeEventListener("pointerdown", clearIfTyping as any, { capture: true });
      window.removeEventListener("keydown", onKeyDown as any, { capture: true });
    };
  }, [hideStatus]);

  const accent = pickAccent(accentColor);

  return (
    <div
      style={{
        position: "relative",                 // ⬅ 중앙 오버레이를 위해
        height: BAR_H,
        background: "var(--topbar)",
        borderBottom: "1px solid var(--topbar-divider)",
        color: "var(--text-1)",
      }}
    >
      {/* 중앙 오버레이 — 항상 절대 중앙 고정 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: BAR_H,
          display: "grid",
          placeItems: "center",
          pointerEvents: "none",             // 클릭 통과
        }}
      >
        <PresetIndicator preset={hud.preset} accent={accent} />
      </div>

      {/* 실제 레이아웃 그리드 (좌/우만 사용) */}
      <div
        style={{
          height: "100%",
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          padding: "0 10px",
        }}
      >
        {/* Left — Sidebar + Status(글자만) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <IconButton src={SIDEBAR_ICON} alt="Sidebar" onClick={onToggleSidebar} />
          {!!status && (
            <div
              title={status}
              style={{
                fontSize: 10,
                lineHeight: "1",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "var(--text-2)",
                letterSpacing: 0.2,
                opacity: 0.9,
                pointerEvents: "none",
                minWidth: 0,
                maxWidth: 260,
              }}
            >
              {status}
            </div>
          )}
        </div>

        {/* Center — 비워둠(오버레이가 담당) */}
        <div />

        {/* Right — ... / Preferences */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifySelf: "end" }}>
          <IconButton alt="More" label="..." onClick={onOpenAbout} />
          <IconButton src={PREFS_ICON} alt="Preferences" onClick={onOpenPreferences} />
        </div>
      </div>
    </div>
  );
};

export default TopBar;