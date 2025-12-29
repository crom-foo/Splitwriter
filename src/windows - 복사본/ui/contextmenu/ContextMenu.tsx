// src/windows/ui/contextmenu/ContextMenu.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
};

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export default function ContextMenu({ open, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!open) return;

    const closeHard = () => {
      (document.activeElement as any)?.blur?.();
      setActive(-1);
      onClose();
    };

    const onPointerDown = (e: Event) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) closeHard();
    };
    const onContext = (e: Event) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) closeHard();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHard();
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((p) => nextEnabledIndex(items, p + 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive((p) => prevEnabledIndex(items, p - 1)); }
      if (e.key === "Enter")     { const it = items[active]; if (it && !it.disabled) { it.onClick?.(); closeHard(); } }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContext, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, items, active, onClose]);

  // 화면 밖 배치 방지
  const style = useMemo(() => {
    const pad = 8;
    const w = 208, h = Math.max(36 * items.length + 12, 48);
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(x, vw - w - pad);
    const top  = Math.min(y, vh - h - pad);
    return { left, top, width: w };
  }, [x, y, items.length]);

  if (!open) return null;

  const panelStyle: React.CSSProperties = {
    background: "var(--panel-bg)",
    border: "1px solid var(--border)",       
    borderRadius: 12,
    padding: 6,
    boxShadow: "0 8px 18px rgba(0,0,0,0), 0 2px 4px rgba(0,0,0,0.05)",
  };

  const baseItem: React.CSSProperties = {
    width: "100%",
    height: 34,
    padding: "0 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    border: "1px solid transparent",
    borderRadius: 8,
    background: "transparent",
    color: "var(--text-1)",
    fontSize: 13,
    cursor: "pointer",
    outline: "none",
    boxShadow: "none",
  };

  const activeItem: React.CSSProperties = {
    background: "color-mix(in srgb, var(--accent) 18%, transparent)",
    borderColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
    boxShadow: "none",                                            
  };

  const disabledItem: React.CSSProperties = {
    opacity: 0.5,
    cursor: "default",
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-hidden={!open}
      className="ctxmenu-root"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseLeave={() => setActive(-1)}
      onBlur={() => setActive(-1)}
      style={{ position: "fixed", zIndex: 9999, ...style }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 전역 포커스/보더 제거 + hover/active는 accent */}
      <style>{`
        .ctxmenu-item:focus,
        .ctxmenu-item:focus-visible,
        .ctxmenu-item:focus-within { outline:none!important; box-shadow:none!important; }
        .ctxmenu-item:hover {
          background: color-mix(in srgb, var(--accent) 12%, transparent) !important;
        }
      `}</style>

      <div className="ctxmenu-panel" style={panelStyle}
           onMouseDown={(e) => e.stopPropagation()}
           onPointerDown={(e) => e.stopPropagation()}>
        {items.map((it, i) => {
          const isActive = i === active && !it.disabled;
          const style: React.CSSProperties = {
            ...baseItem,
            ...(isActive ? activeItem : null),
            ...(it.disabled ? disabledItem : null),
          };
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`ctxmenu-item${isActive ? " is-active" : ""}${it.disabled ? " is-disabled" : ""}`}
              disabled={!!it.disabled}
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(-1)}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={() => { if (!it.disabled) { it.onClick?.(); setActive(-1); onClose(); } }}
              style={style}
            >
              <span className="ctxmenu-label">{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body || document.documentElement
  );
}

function nextEnabledIndex(items: MenuItem[], start: number) {
  for (let i = 0; i < items.length; i++) {
    const idx = (start + i) % items.length;
    if (!items[idx]?.disabled) return idx;
  }
  return -1;
}
function prevEnabledIndex(items: MenuItem[], start: number) {
  for (let i = 0; i < items.length; i++) {
    const idx = (start - i + items.length * 2) % items.length;
    if (!items[idx]?.disabled) return idx;
  }
  return -1;
}
