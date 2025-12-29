// src/windows/boards/texttoolbar.tsx
import React from "react";

export const TOOLBAR_H = 30;

const ICONS = {
  Bold: new URL("../icons/Bold.png", import.meta.url).href,
  Italic: new URL("../icons/Italic.png", import.meta.url).href,
  AlignLeft: new URL("../icons/Align_Left.png", import.meta.url).href,
  AlignCenter: new URL("../icons/Align_Center.png", import.meta.url).href,
  AlignRight: new URL("../icons/Align_Right.png", import.meta.url).href,
  AlignJustify: new URL("../icons/Align_Justify.png", import.meta.url).href,
  EchoView: new URL("../icons/Echo_View.png", import.meta.url).href,
};

export type TypingMode = { bold: boolean; italic: boolean };

export type WritingGoalProps = {
  enabled?: boolean;
  mode?: "chars" | "words";
  target?: number;
  current?: number;
  format?: string;
  quietColor?: string;
  hitColor?: string;
};

export type TextToolbarProps = {
  typingMode: TypingMode;
  onBold: () => void;
  onItalic: () => void;
  onAlignLeft: () => void;
  onAlignCenter: () => void;
  onAlignRight: () => void;
  onAlignJustify: () => void;
  onOpenEcho: () => void;
  onToolbarPointerDown?: () => void;
  style?: React.CSSProperties;
  className?: string;
  writingGoal?: WritingGoalProps;
};

/* ---------- Shared button (preserve original behavior) ---------- */
const btnStyle = (active?: boolean): React.CSSProperties => ({
  width: 26,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 3,
  border: `1px solid ${active ? "rgba(106,168,255,0.8)" : "var(--border)"}`,
  background: active ? "rgba(106,168,255,0.08)" : "var(--btn-bg)",
  filter: active ? "brightness(0.85)" : "none",
  cursor: "pointer",
  userSelect: "none",
  outline: "none",
});

function ToolBtn({
  title,
  active,
  icon,
  onClick,
  onPointerDown,
  className,
  dataCmd,
  // default true: prevent mousedown from stealing focus/selection in the editor
  blockMouseDown = true,
}: {
  title: string;
  active?: boolean;
  icon: string;
  onClick: () => void;
  onPointerDown?: () => void;
  className?: string;
  dataCmd?: string;
  blockMouseDown?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={!!active}
      onMouseDown={(e) => {
        if (blockMouseDown) {
          e.preventDefault();
          e.stopPropagation();
        }
        onPointerDown?.();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        requestAnimationFrame(() => onClick());
      }}
      tabIndex={-1}
      style={btnStyle(active)}
      className={["tb-iconbtn", className].filter(Boolean).join(" ")}
      data-cmd={dataCmd}
      aria-label={title}
    >
      <img src={icon} alt={title} width={14} height={14} draggable={false} />
    </button>
  );
}

/* ---------- Style set (keep the same visual tone as the original) ---------- */
const S = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: TOOLBAR_H,
    marginLeft: 33,
    zIndex: 20,
    pointerEvents: "auto" as const,
  },
  vsep: { width: 1, height: 18, background: "var(--divider)", marginInline: 6 },
};

/* ---------- Main component ---------- */
const TextToolbar: React.FC<TextToolbarProps> = ({
  typingMode,
  onBold,
  onItalic,
  onAlignLeft,
  onAlignCenter,
  onAlignRight,
  onAlignJustify,
  onOpenEcho,
  onToolbarPointerDown,
  style,
  className,
  writingGoal,
}) => {
  const goalEnabled = !!writingGoal?.enabled && (writingGoal?.target ?? 0) > 0;
  const goalMode = writingGoal?.mode ?? "chars";
  const goalTarget = Math.max(0, Number(writingGoal?.target || 0) | 0);
  const currentCount = Math.max(0, Number(writingGoal?.current || 0) | 0);

  const hit = goalEnabled && currentCount >= goalTarget;

  // 테마 토큰 기반 기본값: 라이트/다크 둘 다에서 잘 보이도록
  const quiet =
    writingGoal?.quietColor ||
    "var(--text-2, rgba(15,23,42,0.65))";
  const hitColor =
    writingGoal?.hitColor ||
    "var(--accent-1, var(--accent))";

  return (
    <div className={className} style={{ ...S.row, ...style }}>
      <div style={S.vsep} />

      <ToolBtn
        title="Bold (Ctrl+B)"
        active={typingMode.bold}
        onPointerDown={onToolbarPointerDown}
        onClick={onBold}
        icon={ICONS.Bold}
      />
      <ToolBtn
        title="Italic (Ctrl+I)"
        active={typingMode.italic}
        onPointerDown={onToolbarPointerDown}
        onClick={onItalic}
        icon={ICONS.Italic}
      />

      <div style={S.vsep} />

      <ToolBtn
        title="Align Left"
        onPointerDown={onToolbarPointerDown}
        onClick={onAlignLeft}
        icon={ICONS.AlignLeft}
      />
      <ToolBtn
        title="Align Center"
        onPointerDown={onToolbarPointerDown}
        onClick={onAlignCenter}
        icon={ICONS.AlignCenter}
      />
      <ToolBtn
        title="Align Right"
        onPointerDown={onToolbarPointerDown}
        onClick={onAlignRight}
        icon={ICONS.AlignRight}
      />
      <ToolBtn
        title="Align Justify"
        onPointerDown={onToolbarPointerDown}
        onClick={onAlignJustify}
        icon={ICONS.AlignJustify}
      />

      {/* right spacer */}
      <div style={{ flex: 1 }} />

      {/* Writing Goal */}
      {goalEnabled && (
        <div
          title={`Writing Goal (${goalMode}): ${currentCount} / ${goalTarget}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            letterSpacing: ".02em",
            userSelect: "none",
            padding: "0 4px",
            borderRadius: 6,
            height: 24,
            color: quiet,
          }}
          aria-live="polite"
        >
          <span
            style={{
              color: hit ? hitColor : quiet,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {currentCount.toLocaleString()}
          </span>
          <span style={{ opacity: 0.8 }}>/</span>
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {goalTarget.toLocaleString()}
          </span>
        </div>
      )}

      <ToolBtn
        title="Echo View"
        onPointerDown={onToolbarPointerDown}
        onClick={onOpenEcho}
        icon={ICONS.EchoView}
        className="tb-echo"
        dataCmd="echo"
        blockMouseDown={false}
      />
    </div>
  );
};

export default React.memo(TextToolbar);
