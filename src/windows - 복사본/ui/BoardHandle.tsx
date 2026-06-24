// src/windows/boards/BoardHandle.tsx
import React from "react";

type Props = {
  onMouseDown?: (e: React.MouseEvent) => void;
  src?: string;
  size?: number;  // 아이콘 자체 크기
  title?: string;
};

export default function BoardHandle({
  onMouseDown,
  src = "/assets/icons/Handle.png",
  size = 16,
  title = "Board",
}: Props) {
  return (
    <button
      title={title}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown?.(e);
      }}
      className="sw-board-handle tb-iconbtn"
    >
      {/* 마스크 아이콘 */}
      <div
        className="sw-icon-mask"
        style={{
          width: size,
          height: size,
          WebkitMaskImage: `url(${src})`,
          maskImage: `url(${src})`,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          pointerEvents: "none",
        }}
      />
    </button>
  );
}
