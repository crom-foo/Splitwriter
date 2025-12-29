// src/windows/boards/ImageBoard.tsx
import React, {
  useEffect, useImperativeHandle, useRef, useState, forwardRef
} from "react";

const isTauri = () => !!(window as any).__TAURI_IPC__;
const isPathLike = (s?: string | null) =>
  !!s && (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("\\\\"));
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const IS_DEV = typeof import.meta !== "undefined" && !!((import.meta as any).env?.DEV);

async function resolveImageSrc(raw: string | null): Promise<{ url: string | null; missing: string | null }> {
  if (!raw) return { url: null, missing: null };

  if (/^file:\/\//i.test(raw)) {
    try {
      let p = decodeURI(raw.replace(/^file:\/\//i, ""));
      if (/^[A-Za-z]:\//.test(p)) p = p.replace(/\//g, "\\"); // C:/ → C:\
      if (isTauri()) {
        const { convertFileSrc } = await import("@tauri-apps/api/tauri");
        return { url: convertFileSrc(p), missing: null };
      }
      // Browser environment: cannot access local files — return the path for display only
      return { url: null, missing: p };
    } catch {
      return { url: null, missing: raw };
    }
  }

  if (/^(blob:|data:|https?:|asset:|tauri:|app:)/i.test(raw)) {
    return { url: raw, missing: null };
  }

  if (isPathLike(raw)) {
    if (isTauri()) {
      const { convertFileSrc } = await import("@tauri-apps/api/tauri");
      return { url: convertFileSrc(raw), missing: null };
    }
    // Browser environment: display the path only
    return { url: null, missing: raw };
  }

  return { url: raw, missing: null };
}

export type ImageView = { scale: number; offsetX: number; offsetY: number };
export type ImageBoardHandle = { resetView: () => void };

type Props = React.HTMLAttributes<HTMLDivElement> & {
  src: string | null;
  background?: string;
  inset?: { top?: number; left?: number };
  onOpenContextMenu?: (x: number, y: number) => void;
  onViewChange?: (view: ImageView) => void;
  initialView?: ImageView | undefined;
  displayPath?: string | null;
  forceMissing?: boolean;
};

const EDGE_MARGIN = 14;

const ImageBoard = forwardRef<ImageBoardHandle, Props>(function ImageBoard(
  {
    src,
    background = "var(--bg)",
    inset = { top: 0, left: 0 },
    onOpenContextMenu,
    onViewChange,
    initialView,
    displayPath,
    className,
    style,
    forceMissing = false,
    ...divProps
  },
  ref
) {

  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [container, setContainer] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [scale, setScale]   = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const [shouldFit, setShouldFit] = useState(true);
  const fitLockedRef = useRef(false);

  const [broken, setBroken] = useState(false);

  const [resolved, setResolved] = useState<{ url: string | null; missing: string | null }>({
    url: null,
    missing: null,
  });

  const isRuntimeUrl = (s?: string | null) =>
    !!s && /^(blob:|data:|https?:|asset:|tauri:|file:)/i.test(s || "");

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await resolveImageSrc(src ?? null);
      if (!alive) return;
      setResolved(r);
      // If url exists, treat as valid; if not and missing is set, mark as missing
      setBroken(r.url ? false : !!r.missing);
      setNatural(null); // Trigger re-fit calculation when a new image loads
    })();
    return () => { alive = false; };
  }, [src]);

  useEffect(() => {
    if (initialView && typeof initialView.scale === "number") {
      setScale(initialView.scale);
      setOffset({ x: initialView.offsetX, y: initialView.offsetY });
      setShouldFit(false);
      fitLockedRef.current = true;
    } else {
      setShouldFit(true);
      fitLockedRef.current = false;
    }
  }, [src, initialView?.scale, initialView?.offsetX, initialView?.offsetY]);

  useImperativeHandle(
    ref,
    () => ({
      resetView() {
        setShouldFit(true);
        fitLockedRef.current = false;
        fitToContain();
      },
    }),
    [scale, offset]
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainer({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setContainer({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldFit) return;
    if (fitLockedRef.current) return;
    if (!natural) return;
    fitToContain();
  }, [container.w, container.h, natural, shouldFit]);

  const onImgLoad: React.ReactEventHandler<HTMLImageElement> = (e) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    setBroken(false);
    setNatural({ w: nw, h: nh });
    if (shouldFit && !fitLockedRef.current) {
      fitToContain(nw, nh);
      fitLockedRef.current = true;
      setShouldFit(false);
    }
  };
  const onImgError: React.ReactEventHandler<HTMLImageElement> = () => {
    setBroken(true);
    setNatural(null);
  };

  function fitToContain(nw?: number, nh?: number) {
    const nat = natural ?? (nw && nh ? { w: nw, h: nh } : null);
    if (!nat) {
      setScale(1); setOffset({ x: 0, y: 0 });
      onViewChange?.({ scale: 1, offsetX: 0, offsetY: 0 });
      return;
    }
    const w = Math.max(1, container.w), h = Math.max(1, container.h);
    const s = Math.min(w / nat.w, h / nat.h);
    setScale(s); setOffset({ x: 0, y: 0 });
    onViewChange?.({ scale: s, offsetX: 0, offsetY: 0 });
  }

  const drag = useRef({ active: false, x: 0, y: 0, ox: 0, oy: 0, id: 0 });

  const onPointerDown: React.PointerEventHandler = (e) => {
    const nearEdge =
      e.clientX <= EDGE_MARGIN ||
      e.clientY <= EDGE_MARGIN ||
      window.innerWidth - e.clientX <= EDGE_MARGIN ||
      window.innerHeight - e.clientY <= EDGE_MARGIN;
    if (nearEdge) return;

    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      active: true, x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, id: e.pointerId
    };
  };

  const onPointerMove: React.PointerEventHandler = (e) => {
    if (!(e.buttons & 1)) {
      if (drag.current.active) onPointerUp(e);
      return;
    }
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    const newOffset = { x: drag.current.ox + dx, y: drag.current.oy + dy };
    setOffset(newOffset);
    onViewChange?.({ scale, offsetX: newOffset.x, offsetY: newOffset.y });
  };

  const endDrag = (el: HTMLElement | null, id: number) => {
    drag.current.active = false;
    try { el?.releasePointerCapture(id); } catch {}
  };

  const onPointerUp: React.PointerEventHandler = (e) => {
    if (!drag.current.active) return;
    endDrag(e.currentTarget as HTMLElement, drag.current.id);
  };

  const onPointerCancel: React.PointerEventHandler = (e) => {
    if (!drag.current.active) return;
    endDrag(e.currentTarget as HTMLElement, drag.current.id);
  };

  const onPointerCaptureLost: React.PointerEventHandler = (e) => {
    if (!drag.current.active) return;
    endDrag(e.currentTarget as HTMLElement, drag.current.id);
  };

  const onContextMenu: React.MouseEventHandler = (e) => {
    e.preventDefault();
    onOpenContextMenu?.(e.clientX, e.clientY);
  };

  const onDoubleClick: React.MouseEventHandler = () => {
    setShouldFit(true);
    fitLockedRef.current = false;
    fitToContain();
  };

  const cssW = natural ? natural.w * scale : 0;
  const cssH = natural ? natural.h * scale : 0;

  const left = (container.w / 2 - cssW / 2) + offset.x + (inset.left ?? 0);
  const top  = (container.h / 2 - cssH / 2) + offset.y + (inset.top  ?? 0);

  const empty = !src;
  const hasRuntime = isRuntimeUrl(resolved.url);
  const isMissing  = !empty && (!hasRuntime && (forceMissing || broken || !!resolved.missing || !resolved.url));

    if (IS_DEV && forceMissing && hasRuntime) {
    console.warn("[ImageBoard] forceMissing ignored because a runtime URL exists:", resolved.url);
  }

  const rawPath  = displayPath ?? resolved.missing ?? src ?? "";
  const pathStr  = normalizePath(rawPath);
  const safeName = pathStr ? baseName(pathStr) : "";

  return (
    <div
      ref={wrapRef}
      {...divProps}
      className={["no-drag", className].filter(Boolean).join(" ")}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background,
        userSelect: "none",
        outline: "none",
        borderRadius: 0,            
        ...style
      }}
      onContextMenu={onContextMenu}
      onWheel={(e) => {
        if (!natural) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = clamp(scale * factor, 0.05, 32);
        const rect = wrapRef.current!.getBoundingClientRect();
        const cssW0 = natural.w * scale;
        const cssH0 = natural.h * scale;

        const imgLeft = rect.left + (container.w / 2 - cssW0 / 2) + offset.x;
        const imgTop  = rect.top  + (container.h / 2 - cssH0 / 2) + offset.y;

        const cx = e.clientX - imgLeft;
        const cy = e.clientY - imgTop;

        const k = next / scale;
        const newOffset = {
          x: offset.x - (cx - cssW0 / 2) * (k - 1),
          y: offset.y - (cy - cssH0 / 2) * (k - 1),
        };
        setScale(next);
        setOffset(newOffset);
        fitLockedRef.current = true;
        setShouldFit(false);
        onViewChange?.({ scale: next, offsetX: newOffset.x, offsetY: newOffset.y });
      }}
      tabIndex={0}
      onMouseDown={(e) => {
        (e.currentTarget as HTMLElement).focus();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCaptureLost}
      onDoubleClick={onDoubleClick}
    >
      {!src ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--text-2)",
            textAlign: "center",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <div style={{ fontSize: 14, lineHeight: 1.15, opacity: 0.95 }}>
            Right-click and choose <b>Change Image</b>
          </div>
          <div style={{ fontSize: 10, lineHeight: 1.1, opacity: 0.82 }}>
            PNG · JPG · JPEG · WEBP · GIF · BMP
          </div>
        </div>
      ) : (
        <>
          <img
            src={resolved.url ?? undefined}
            alt=""
            draggable={false}
            onLoad={onImgLoad}
            onError={onImgError}
            style={{
              position: "absolute",
              width: cssW ? `${cssW}px` : undefined,
              height: cssH ? `${cssH}px` : undefined,
              left,
              top,
              maxWidth: "none",
              maxHeight: "none",
              userSelect: "none",
              pointerEvents: "none",
              display: isMissing ? "none" : undefined, 
            }}
          />
          {isMissing && (
            <>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-2)",
                  pointerEvents: "none",
                }}
              >
                <div style={{ fontSize: 18, fontWeight: 650, opacity: 0.95 }}>Image not found</div>
              </div>
              {!!safeName && (
                <div
                  style={{
                    position: "absolute",
                    left: 12, right: 12, bottom: "50%",
                    transform: "translateY(48px)",
                    fontSize: 12,
                    color: "var(--text-3)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    pointerEvents: "none",
                    textAlign: "center",
                  }}
                  title={safeName}
                >
                  {safeName}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
});

export default ImageBoard;

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function normalizePath(raw: string): string {
  if (!raw) return "";
  if (/^data:/i.test(raw)) return "(data url)";
  if (/^blob:/i.test(raw)) return "(blob url)";

  // file:// → normalize to an OS path
  if (/^file:\/\//i.test(raw)) {
    try {
      let p = decodeURI(raw.replace(/^file:\/\//i, ""));
      // Normalize Windows drive notation: C:/foo → C:\foo
      if (/^[A-Za-z]:\//.test(p)) p = p.replace(/\//g, "\\");
      return p;
    } catch {
      return raw;
    }
  }

  // Already an absolute path (Windows) or a Unix root path
  if (/^[A-Za-z]:\\/.test(raw) || raw.startsWith("/")) return raw;

  // Otherwise (http, etc.) return as-is
  return raw;
}
