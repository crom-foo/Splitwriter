// src/windows/panes/SplitPane.tsx
import React from "react";

type Dir = "vertical" | "horizontal";

type Props = {
  direction: Dir;
  ratio: number;                       // 0..1
  onChange: (next: number) => void;
  gutterSize?: number;                 // 가터 두께
  minA?: number;                       // A 최소 px
  minB?: number;                       // B 최소 px
  pathKey?: string;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  a: React.ReactNode;
  b: React.ReactNode;
};

const clamp01 = (x: number) => Math.max(0.0001, Math.min(0.9999, x));

export default function SplitPane({
  direction,
  ratio,
  onChange,
  gutterSize = 2,
  minA = 48,
  minB = 48,
  pathKey,
  onDragStart,
  onDragEnd,
  a,
  b,
}: Props) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const aCellRef = React.useRef<HTMLDivElement | null>(null);
  const bCellRef = React.useRef<HTMLDivElement | null>(null);

  const R = clamp01(ratio);

  // 드래그 상태
  const draggingRef = React.useRef(false);
  const ptrIdRef = React.useRef<number | null>(null);
  const dragRef = React.useRef<{ size: number; start: number; axis0: number } | null>(null);

  const isVert = direction === "vertical";

  /**
   * 더블클릭:
   * - 이 SplitPane 안에서, 가터 양옆에 실제로 붙어 있는 두 보드를
   *   elementFromPoint로 찾아서 그 둘의 합 영역(A_min ~ B_max)의 정중앙으로 선 이동.
   * - 부모/자식 트리 구조는 신경 안 쓰고 "화면에 보이는 이 선 기준 양옆 보드"만 본다.
   */
  const centerSplit = React.useCallback(
    (overlay?: HTMLElement) => {
      const root = rootRef.current;
      if (!root) {
        onChange(0.5);
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const size = isVert ? rootRect.width : rootRect.height;
      if (!size || !Number.isFinite(size)) {
        onChange(0.5);
        return;
      }

      const maxA = Math.max(minA, size - gutterSize - minB);
      const sampleDist = Math.max(2, gutterSize || 2);

      // 가터의 현재 화면상 중앙 좌표(gx, gy)
      // ← 여기서 x는 항상 width, y는 항상 height 기준으로 계산
      let gx = rootRect.left + rootRect.width / 2;
      let gy = rootRect.top + rootRect.height / 2;

      if (overlay) {
        const o = overlay.getBoundingClientRect();
        gx = o.left + o.width / 2;
        gy = o.top + o.height / 2;
      } else {
        // overlay가 없으면 현재 A 셀 기준으로 대충 중앙 추정 (fallback)
        const aWrap = aCellRef.current;
        if (aWrap) {
          const aRect = aWrap.getBoundingClientRect();
          if (isVert) {
            gx = aRect.right + gutterSize / 2;
          } else {
            gy = aRect.bottom + gutterSize / 2;
          }
        }
      }

      // overlay가 elementFromPoint 를 가리지 않도록 잠시 비활성화
      const prevPE = overlay ? overlay.style.pointerEvents : "";
      if (overlay) overlay.style.pointerEvents = "none";

      const leftEl = document.elementFromPoint(
        isVert ? gx - sampleDist : gx,
        isVert ? gy : gy - sampleDist
      ) as HTMLElement | null;
      const rightEl = document.elementFromPoint(
        isVert ? gx + sampleDist : gx,
        isVert ? gy : gy + sampleDist
      ) as HTMLElement | null;

      if (overlay) overlay.style.pointerEvents = prevPE;

      // ↑에서 잡힌 엘리먼트가 보드 내부(div 등)일 수 있으니
      // 가장 가까운 .sw-cell 까지 올라가서 그 rect 를 쓴다.
      const findCellRect = (el: HTMLElement | null): DOMRect | null => {
        if (!el) return null;
        let cur: HTMLElement | null = el;
        while (cur && cur !== root) {
          if (cur.classList?.contains("sw-cell")) {
            return cur.getBoundingClientRect();
          }
          cur = cur.parentElement;
        }
        return el.getBoundingClientRect();
      };

      const leftRect = findCellRect(leftEl);
      const rightRect = findCellRect(rightEl);

      // 둘 중 하나라도 못 찾으면 그냥 50:50으로
      if (!leftRect || !rightRect) {
        const avail = Math.max(0, size - gutterSize);
        const midA = Math.round(avail / 2);
        const clampedA = Math.max(minA, Math.min(maxA, midA));
        onChange(clamp01(clampedA / size));
        return;
      }

      // 축 방향 좌표
      const axisStart = isVert ? rootRect.left : rootRect.top;
      const aMin = isVert ? leftRect.left : leftRect.top;
      const bMax = isVert ? rightRect.right : rightRect.bottom;

      // A_min ~ B_max 전체 길이의 중앙이 "두 보드를 반씩" 나누는 선
      const centerAxis = aMin + (bMax - aMin) / 2;

      // 이 중앙 좌표를 기준으로 가터 중앙이 오도록 A 폭(px) 역산
      let nextApx = centerAxis - axisStart - gutterSize / 2;

      // 최소/최대 보장
      nextApx = Math.max(minA, Math.min(maxA, nextApx));

      const ratioNext = nextApx / size;
      onChange(clamp01(ratioNext));
    },
    [gutterSize, isVert, minA, minB, onChange]
  );

  /* ───── Grid 레이아웃 ───── */
  const gridStyle: React.CSSProperties = isVert
    ? {
        display: "grid",
        gridTemplateColumns: `minmax(${minA}px, ${R * 100}%) ${gutterSize}px minmax(${minB}px, 1fr)`,
        gridTemplateRows: "1fr",
        alignItems: "stretch",
        justifyItems: "stretch",
      }
    : {
        display: "grid",
        gridTemplateRows: `minmax(${minA}px, ${R * 100}%) ${gutterSize}px minmax(${minB}px, 1fr)`,
        gridTemplateColumns: "1fr",
        alignItems: "stretch",
        justifyItems: "stretch",
      };

  const cellCommon: React.CSSProperties = {
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    width: "100%",
    height: "100%",
  };

  const visualStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.10)",
    boxShadow: isVert
      ? "inset 1px 0 rgba(255,255,255,0.06), inset -1px 0 rgba(0,0,0,0.35)"
      : "inset 0 1px rgba(255,255,255,0.06), inset 0 -1px rgba(0,0,0,0.35)",
    pointerEvents: "none", // 순수 시각선
  };

  /* ───── 드래그 히트박스(가터 중앙에 정렬) ───── */
  const HIT = Math.max(16, gutterSize + 12);
  const hitStyle: React.CSSProperties = isVert
    ? {
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `calc(${R * 100}% + ${gutterSize / 2}px - ${HIT / 2}px)`, // 가터 중앙 보정
        width: HIT,
        cursor: "col-resize",
        zIndex: 10,
        touchAction: "none",
        userSelect: "none",
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        top: `calc(${R * 100}% + ${gutterSize / 2}px - ${HIT / 2}px)`,
        height: HIT,
        cursor: "row-resize",
        zIndex: 10,
        touchAction: "none",
        userSelect: "none",
      };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    rootRef.current?.style.setProperty("user-select", "none");

    const root = rootRef.current;
    if (!root) return;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrIdRef.current = e.pointerId;
    draggingRef.current = true;

    const rect = root.getBoundingClientRect();
    const size = isVert ? rect.width : rect.height;
    const axis0 = isVert ? e.clientX : e.clientY;
    dragRef.current = { size, start: R * size, axis0 };

    onDragStart?.();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    e.preventDefault();
    if (!draggingRef.current) return;
    if ((e.buttons & 1) === 0) {
      endDrag(e);
      return;
    }

    const d = dragRef.current;
    if (!d) return;

    const cur = isVert ? e.clientX : e.clientY;
    const nextA = Math.max(minA, Math.min(d.size - minB, d.start + (cur - d.axis0)));
    onChange(clamp01(nextA / d.size));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    dragRef.current = null;
    try {
      if (ptrIdRef.current != null) {
        (e.currentTarget as HTMLElement).releasePointerCapture(ptrIdRef.current);
      }
    } catch {}
    ptrIdRef.current = null;
    rootRef.current?.style.removeProperty("user-select");
    onDragEnd?.();
  };

  return (
    <div
      className="sw-pane"
      data-dir={direction}
      data-key={pathKey}
      ref={rootRef}
      style={{
        position: "relative",
        boxSizing: "border-box",
        minWidth: 0,
        minHeight: 0,
        width: "100%",
        height: "100%",
        ...gridStyle,
      }}
    >
      {/* A 셀 */}
      <div
        className="sw-cell"
        ref={aCellRef}
        style={{ ...cellCommon, ...(isVert ? { gridColumn: 1 } : { gridRow: 1 }) }}
      >
        {a}
      </div>

      {/* Gutter 시각선(클릭 처리 없음) */}
      <div
        style={{
          ...(isVert ? { gridColumn: 2, width: gutterSize } : { gridRow: 2, height: gutterSize }),
          ...visualStyle,
        }}
        aria-hidden
      />

      {/* B 셀 */}
      <div
        className="sw-cell"
        ref={bCellRef}
        style={{ ...cellCommon, ...(isVert ? { gridColumn: 3 } : { gridRow: 3 }) }}
      >
        {b}
      </div>

      {/* 히트박스 오버레이(더블클릭 → 중앙 스냅) */}
      <div
        style={hitStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            if (ptrIdRef.current != null) {
              (e.currentTarget as HTMLElement).releasePointerCapture(ptrIdRef.current);
            }
          } catch {}
          draggingRef.current = false;
          dragRef.current = null;
          ptrIdRef.current = null;
          rootRef.current?.style.removeProperty("user-select");
          centerSplit(e.currentTarget as HTMLElement);
        }}
      />
    </div>
  );
}
