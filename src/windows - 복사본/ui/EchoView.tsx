import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

export type Typeface = { name?: string; size?: number };
export type TypefaceTable = {
  headline?: Typeface;
  body?: Typeface;
  accent?: Typeface;
  etc?: Typeface;
};

type EchoReaderProps = {
  open: boolean;
  onClose: () => void;

  /** Typeface presets from TextBoard (kept in sync with Preferences) */
  typefaces?: TypefaceTable;
  /** 1=Headline, 2=Body, 3=Accent, 4=Etc */
  preset?: number;

  /** Fallback family/size if a preset slot is missing */
  fontFamily?: string;
  fontSize?: number;

  /** Full text to read */
  text?: string;

  /** Start reading from this chunk index (inclusive), relative to tokenized sentences */
  startAt?: number;

  // ----- Visual parameters -----
  /** Background mix ratio with --accent (0–100), default 20 */
  accentMix?: number;
  /** Border mix ratio with --accent (0–100), default 50 */
  borderMix?: number;
  /** Border width in px, default 1.5 */
  borderWidth?: number;
  /** Box corner radius in px, default 16 */
  radius?: number;
  /** Box fill opacity (0–1), default 0.88 */
  boxOpacity?: number;

  /** Initial font-size offset (px) added to the preset size; can be adjusted in-session with +/- */
  sizeOffset?: number;
  /** Line-height for the reader, default 1.9 */
  lineHeight?: number;
  /** Max text box width in px, default 980 */
  maxWidth?: number;
  /** Optional title shown at the footer */
  title?: string;

  // ----- Background images -----
  /** Optional list of background image URLs; cycle with [ and ] */
  bgSources?: string[];
  /** Darken overlay over the background image (0–1), default 0.08 */
  bgDarken?: number;
};

const END_PUNCT = /[\.!?…]+/;
const CLOSERS = `”’"'\\)\\]\\}〉》」『】>`;

/** Split text into displayable chunks (rough sentence/phrase units). */
function tokenizeEchoText(src?: string): string[] {
  if (!src) return [];
  const text = src.replace(/\r\n/g, "\n").replace(/\t/g, " ");
  const paras = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const p of paras) {
    const re = new RegExp(`(.+?${END_PUNCT.source}(?:[${CLOSERS}])?)`, "g");
    let m: RegExpExecArray | null,
      last = 0;
    while ((m = re.exec(p)) !== null) {
      out.push(m[1].trim());
      last = re.lastIndex;
    }
    const rest = p.slice(last).trim();
    if (rest) out.push(rest);
  }
  return out;
}

/** Resolve the active typeface from the given preset or fallbacks. */
const tfByPreset = (
  preset?: number,
  typefaces?: TypefaceTable,
  fallbackFamily?: string,
  fallbackSize?: number
) => {
  const key =
    preset === 1 ? "headline" : preset === 3 ? "accent" : preset === 4 ? "etc" : "body";
  const tf = (typefaces as any)?.[key] || {};
  return {
    family: (tf.name || fallbackFamily || "system-ui, sans-serif") as string,
    size: Number(tf.size || fallbackSize || 19),
  };
};

const EchoReader: React.FC<EchoReaderProps> = ({
  open,
  onClose,
  typefaces,
  preset = 2,
  fontFamily,
  fontSize,
  text,

  // visuals
  accentMix = 20,
  borderMix = 50,
  borderWidth = 2,
  radius = 16,
  boxOpacity = 0.88,
  sizeOffset = 2,
  lineHeight = 1.9,
  maxWidth = 980,
  title = "",

  // backgrounds
  bgSources,
  bgDarken = 0.08,

  // start from caret index
  startAt = 0,
}) => {
  // Portal host: create once on mount; remove on unmount.
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "echo-reader-root";
    document.body?.appendChild(el);
    hostRef.current = el;
    return () => {
      document.body.removeChild(el);
      hostRef.current = null;
    };
  }, []);

  // Tokenize and slice from the requested start chunk.
  const chunks = useMemo(() => tokenizeEchoText(text), [text]);
  const start = Math.max(0, Math.min(startAt ?? 0, chunks.length));
  const view = useMemo(() => chunks.slice(start), [chunks, start]);
  const hasView = view.length > 0;

  // Current chunk index (relative to `view`).
  const [idx, setIdx] = useState(0);
  // Reset index when re-opened or the start changes.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open, start]);

  // Background image cycling index.
  const [bgIndex, setBgIndex] = useState(0);

  const next = useCallback(
    () => setIdx((i) => Math.min(i + 1, Math.max(0, view.length - 1))),
    [view.length]
  );
  const prev = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), []);

  // Auto-skip empty chunks (view-relative).
  useEffect(() => {
    if (!open || !hasView) return;
    let i = idx;
    while (i < view.length && view[i].trim().length === 0) i++;
    if (i !== idx) setIdx(i);
  }, [open, hasView, idx, view]);

  // Resolve typeface from preset and allow in-session size adjustments.
  const { family, size } = tfByPreset(preset, typefaces, fontFamily, fontSize);
  const [sizeDelta, setSizeDelta] = useState<number>(Number(sizeOffset || 0));
  useEffect(() => {
    if (open) setSizeDelta(Number(sizeOffset || 0));
  }, [open, sizeOffset]);
  const finalSize = Math.max(10, Math.round((Number(size) + sizeDelta) * 100) / 100);

  // Compute colors (clamped ratios).
  const bgMix = Math.min(100, Math.max(0, accentMix));
  const bdMix = Math.min(100, Math.max(0, borderMix));
  const safeBoxOpacity = Math.max(0, Math.min(1, boxOpacity ?? 1));
  const boxBg = `color-mix(in oklab, #000 ${100 - bgMix}%, var(--accent, #3ea1ff) ${bgMix}%)`;
  const boxBorder = `color-mix(in oklab, #000 ${100 - bdMix}%, var(--accent, #3ea1ff) ${bdMix}%)`;
  const ringPx = Math.max(2, Math.round(borderWidth));
  const boxFill = `color-mix(in oklab, ${boxBg} ${Math.round(
    safeBoxOpacity * 100
  )}%, transparent ${Math.round((1 - safeBoxOpacity) * 100)}%)`;

  // Current background image URL (if any).
  const bgUrl =
    bgSources && bgSources.length > 0
      ? bgSources[(bgIndex % bgSources.length + bgSources.length) % bgSources.length]
      : undefined;

  // ★ 안전장치: text 를 못쪼갰으면 자동으로 닫기 (키 리스너도 안 붙이게)
  useEffect(() => {
    if (open && !hasView) {
      onClose();
    }
  }, [open, hasView, onClose]);

  // Keyboard controls.
  useEffect(() => {
    // 열려 있고, 보여줄 문장이 있을 때만 전역 키 리스너 활성화
    if (!open || !hasView) return;

    const onKey = (e: KeyboardEvent) => {
      const key = e.key;

      if (key === "Escape") {
        onClose();
        return;
      }

      // 다음 / 이전
      if (key === "ArrowRight" || key === " " || key === "Enter") {
        e.preventDefault();
        next();
        return;
      }
      if (key === "ArrowLeft" || key === "Backspace") {
        e.preventDefault();
        prev();
        return;
      }

      // Background cycle
      if (key === "]" && (bgSources?.length ?? 0) > 0) {
        e.preventDefault();
        setBgIndex((i) => (i + 1) % bgSources!.length);
        return;
      }
      if (key === "[" && (bgSources?.length ?? 0) > 0) {
        e.preventDefault();
        setBgIndex((i) => (i - 1 + bgSources!.length) % bgSources!.length);
        return;
      }

      // Font size (session only)
      if (key === "+" || key === "=") {
        e.preventDefault();
        setSizeDelta((v) => Math.min(v + 1, 18));
        return;
      }
      if (key === "-" || key === "_") {
        e.preventDefault();
        setSizeDelta((v) => Math.max(v - 1, -12));
        return;
      }
    };

    // capture:true 를 boolean 으로 명시 → removeEventListener 와 1:1 매칭
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, hasView, onClose, next, prev, bgSources?.length]);

  if (!open || !hasView || !hostRef.current) return null;

  // If there is no background image, make the text box slightly wider for presence.
  const hasBg = !!bgUrl;
  const boxMaxWidth = hasBg ? maxWidth ?? 980 : Math.max(maxWidth ?? 980, 1040);

  return createPortal(
    <div
      onClick={next}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "#000",
        display: "grid",
        gridTemplateRows: hasBg ? "10fr auto 1fr" : "1fr auto 1fr",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      {/* Background image (unfiltered original, longest side ≤ 1080px) */}
      {bgUrl && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 1,
            pointerEvents: "none",
          }}
        >
          <img
            src={bgUrl}
            alt=""
            style={{
              maxWidth: "min(1080px, 90vw)",
              maxHeight: "min(1080px, 85vh)",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              filter: "none",
            }}
          />
        </div>
      )}

      {/* Optional darken overlay for readability */}
      {bgUrl && bgDarken > 0 && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(0,0,0,${bgDarken})`,
          }}
        />
      )}

      <div />

      {/* Center text box */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 24px",
          zIndex: 1,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: typeof boxMaxWidth === "number" ? boxMaxWidth : (boxMaxWidth as any),
            background: boxFill,
            borderRadius: radius,
            border: "none",
            boxShadow: `0 0 0 ${ringPx}px ${boxBorder}, 0 10px 30px rgba(0,0,0,.55)`,
            padding: hasBg ? "2.2vh 24px 4vh" : "16px 24px",
            fontFamily: family,
            fontSize: finalSize,
            lineHeight,
            letterSpacing: ".01em",
            color: "color-mix(in srgb, #e9edf2 82%, #000 18%)",
            textRendering: "optimizeLegibility",
            minHeight: 120,
            transition: "opacity .18s ease",
            opacity: 1,
          }}
        >
          {view[idx]}
        </div>
      </div>

      {/* Footer: hints and title */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          padding: "0 16px 14px",
          color: "rgba(255,255,255,0.26)",
          fontSize: 12,
          letterSpacing: ".06em",
          zIndex: 1,
        }}
      >
        <span>{title}</span>
        <span>
          {idx >= view.length - 1 ? (
            "End of text — press Esc to exit"
          ) : (
            <>
              ← / → · Space · Esc
              {bgSources && bgSources.length > 1 ? "  ·  [ / ] : Background" : ""}
              {"  ·  + / - : Size"}
            </>
          )}
        </span>
      </div>
    </div>,
    hostRef.current
  );
};

export default EchoReader;
