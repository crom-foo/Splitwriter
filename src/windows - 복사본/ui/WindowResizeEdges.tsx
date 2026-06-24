// src/windows/ui/WindowResizeEdges.tsx
import React from "react";

type Dir = "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW";

async function startResize(dir: Dir) {
  // No-op on web; works on Tauri only
  // @ts-ignore
  if (!(window as any).__TAURI_IPC__) return;
  const { appWindow } = await import("@tauri-apps/api/window");
  const map = {
    N: "North",
    S: "South",
    E: "East",
    W: "West",
    NE: "NorthEast",
    NW: "NorthWest",
    SE: "SouthEast",
    SW: "SouthWest",
  } as const;
  // @ts-ignore
  await appWindow.startResizeDragging(map[dir]);
}

const Z = 2147483600;     // make sure it's on top
const EDGE = 8;           // thickness of edges (px)
const CORNER = 14;        // hit area for corners (px)

const baseWrap: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: Z,
};

const seg = (style: React.CSSProperties): React.CSSProperties => ({
  position: "fixed",
  pointerEvents: "auto",
  userSelect: "none",
  WebkitAppRegion: "no-drag", // important: allow mouse events
  ...style,
});

const WindowResizeEdges: React.FC = () => {
  return (
    <div style={baseWrap} aria-hidden>
      {/* Edges */}
      <div
        style={seg({ top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" })}
        onPointerDown={() => startResize("N")}
      />
      <div
        style={seg({ bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" })}
        onPointerDown={() => startResize("S")}
      />
      <div
        style={seg({ top: CORNER, bottom: CORNER, right: 0, width: EDGE, cursor: "ew-resize" })}
        onPointerDown={() => startResize("E")}
      />
      <div
        style={seg({ top: CORNER, bottom: CORNER, left: 0, width: EDGE, cursor: "ew-resize" })}
        onPointerDown={() => startResize("W")}
      />

      {/* Corners */}
      <div
        style={seg({ top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" })}
        onPointerDown={() => startResize("NW")}
      />
      <div
        style={seg({ top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" })}
        onPointerDown={() => startResize("NE")}
      />
      <div
        style={seg({ bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" })}
        onPointerDown={() => startResize("SW")}
      />
      <div
        style={seg({ bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" })}
        onPointerDown={() => startResize("SE")}
      />
    </div>
  );
};

export default React.memo(WindowResizeEdges);
