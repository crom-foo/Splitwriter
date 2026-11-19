// src/windows/panes/LeafPane.tsx
/**
 * LeafPane
 * Wraps a single board and exposes a split handle (top-left).
 * Drag the handle to choose horizontal/vertical; emits onRequestSplit.
 * Shows a non-interactive H/V guide overlay during drag (no layout impact).
 */
import React, { useEffect, useState } from "react";
import handleIcon from "../icons/handle.png";
import { readNavigatorBoardDrag, type BoardGroup, type NavigatorBoardDrag } from "../boards/boardDrag";

type LeafKind = "text" | "scenario" | "image" | "viewer" | "edit" | "navigator" | "manuscript";

type Props = {
  leafId: string;
  kind: LeafKind;
  children: React.ReactNode;
  onOpenMenu?: (
    leafId: string,
    pt: { x: number; y: number },
    source?: "handle" | "content"
  ) => void;
  onRequestSplit?: (leafId: string, dir: "horizontal" | "vertical") => void;
  onActivate?: () => void;
  onRequestSwap?: (sourceLeafId: string, targetLeafId: string) => void;
  onSwapTargetChange?: (targetLeafId: string | null) => void;
  swapTargetLeafId?: string | null;
  accentColor?: string;
  dropGroup?: BoardGroup | "any";
  onDropNavigatorBoard?: (item: NavigatorBoardDrag) => void;
};

export default function LeafPane({
  leafId,
  kind,
  children,
  onOpenMenu,
  onRequestSplit,
  onActivate,
  onRequestSwap,
  onSwapTargetChange,
  swapTargetLeafId,
  accentColor,
  dropGroup,
  onDropNavigatorBoard,
}: Props) {
  const swapAccent = accentColor || "var(--accent)";
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [dir, setDir] = useState<"horizontal" | "vertical" | null>(null);
  const swapTargetRef = React.useRef<string | null>(null);

  const onDropNavigator = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dropGroup) return;
    const payload = readNavigatorBoardDrag(event.dataTransfer);
    if (!payload || (dropGroup !== "any" && payload.group !== dropGroup)) return;
    event.preventDefault();
    event.stopPropagation();
    onDropNavigatorBoard?.(payload);
  };

  // Direction detection: lock to H or V after movement exceeds ~6px to avoid jitter.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      if (!start) return;
      const p = { x: e.clientX, y: e.clientY };
      const targetEl = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-sw-leaf-id]");
      const targetLeafId = targetEl?.dataset.swLeafId && targetEl.dataset.swLeafId !== leafId
        ? targetEl.dataset.swLeafId
        : null;
      if (swapTargetRef.current !== targetLeafId) {
        swapTargetRef.current = targetLeafId;
        onSwapTargetChange?.(targetLeafId);
      }
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      setDir(targetLeafId || (adx < 6 && ady < 6) ? null : ady > adx ? "horizontal" : "vertical");
    };

    const onUp = () => {
      setDragging(false);
      const targetLeafId = swapTargetRef.current;
      if (targetLeafId) onRequestSwap?.(leafId, targetLeafId);
      else if (dir) onRequestSplit?.(leafId, dir);
      swapTargetRef.current = null;
      onSwapTargetChange?.(null);
      setDir(null);
      setStart(null);
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [dragging, dir, leafId, onRequestSplit, onRequestSwap, onSwapTargetChange, start]);

  // Drag hint overlay: draws a 2px guide line and a small "H"/"V" chip; pointer-events: none.
  const renderPreview = () => {
    if (!dragging || !dir) return null;

    const guideColor =
      "color-mix(in srgb, var(--text-muted) 25%, transparent)";

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 13,
        }}
      >
        {dir === "horizontal" ? (
          <div
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              top: "50%",
              height: 2,
              transform: "translateY(-1px)",
              background: guideColor, 
              boxShadow: "none",
              borderRadius: 1,
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              top: 8,
              bottom: 8,
              left: "50%",
              width: 2, // 2px → 3px
              transform: "translateX(-1px)",
              background: guideColor, 
              boxShadow: "none",
              borderRadius: 1,
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 36,
            padding: "4px 8px",
            fontSize: 12,
            borderRadius: 8,
            background: "rgba(26,28,32,0.98)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e7eaee",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {dir === "horizontal" ? "H" : "V"}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        outline: "none",
      }}
      data-sw-navigator-target={dropGroup ? "1" : undefined}
      data-sw-leaf-id={leafId}
      data-sw-leaf-kind={kind}
      onDragOverCapture={(event) => {
        if (!dropGroup) return;
        // Always accept over a board pane; DataTransfer payloads are hidden during dragover.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDropCapture={onDropNavigator}
      // Forward board-body context menu to parent with source="content".
      onContextMenu={(e) => {
        // Navigator owns its own item menus. Blank space, separators, and the
        // horizontal draft scroller must not fall through to the pane menu.
        if ((e.target as Element | null)?.closest?.('[data-sw-navigator-root]')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Navigator order tabs own their context menu; don't open a second
        // pane-level menu for the same right-click.
        if ((e.target as Element | null)?.closest?.('[role="tablist"]')) return;
        if (!onOpenMenu) return;
        e.preventDefault();
        onOpenMenu(leafId, { x: e.clientX, y: e.clientY }, "content");
      }}
    >
      <div
        style={{ position: "absolute", inset: 0, minWidth: 0, minHeight: 0 }}
        onPointerDownCapture={(event) => {
          if (event.button === 0) onActivate?.();
        }}
        onFocusCapture={() => onActivate?.()}
      >
        {children}
      </div>

      {swapTargetLeafId === leafId && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 13,
            boxSizing: "border-box",
            border: `1px solid ${swapAccent}`,
            pointerEvents: "none",
          }}
        />
      )}

      {swapTargetLeafId === leafId && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 38,
            left: 12,
            zIndex: 14,
            padding: "4px 8px",
            border: `1px solid color-mix(in srgb, ${swapAccent} 42%, transparent)`,
            borderRadius: 5,
            background: `color-mix(in srgb, ${swapAccent} 16%, var(--panel-bg))`,
            color: "var(--text-1)",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: "0.02em",
            pointerEvents: "none",
          }}
        >
          Swap
        </div>
      )}

      {/* Pane handle: drag within this pane to split, onto another pane to swap. */}
      {kind !== "manuscript" && <div
        title="Drag to split or swap panes"
        onContextMenu={(e) => {
          if (!onOpenMenu) return;
          e.preventDefault();
          e.stopPropagation();
          onOpenMenu(leafId, { x: e.clientX, y: e.clientY }, "handle");
        }}
        onMouseDown={(e) => {
          // 좌클릭 드래그로만 split 시작
          if (e.button !== 0) return;
          e.stopPropagation();
          setDragging(true);
          setStart({ x: e.clientX, y: e.clientY });
        }}
        className="sw-board-handle tb-iconbtn"
        style={{
          position: "absolute",
          top: 3,
          left: 11,
          zIndex: 12,
          cursor: dragging ? "grabbing" : "grab",
        }}
      >
        <img
          src={handleIcon}
          alt="handle"
          className="sw-icon"
          draggable={false}
          style={{ pointerEvents: "none" }}
        />
      </div>}

      {renderPreview()}
    </div>
  );
}
