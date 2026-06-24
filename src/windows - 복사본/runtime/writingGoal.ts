// src/windows/runtime/writingGoal.ts
import * as React from "react";

export type WritingGoalPref = {
  enabled?: boolean;
  target?: number;
  mode?: "words" | "chars";
  unit?: "words" | "chars" | "character" | "characters";
  quietColor?: string;
  format?: string;
};

export function useWritingGoal(
  editorRef: React.RefObject<HTMLElement>,
  pref?: WritingGoalPref
) {
  const goalEnabled = !!pref?.enabled && (pref?.target ?? 0) > 0;
  const rawMode = pref?.mode ?? pref?.unit ?? "words";
  const goalMode = (rawMode === "character" || rawMode === "characters"
    ? "chars"
    : rawMode) as "words" | "chars";
  const goalTarget = Math.max(0, Number(pref?.target || 0) | 0);
  const quiet = pref?.quietColor || "rgba(231,234,238,0.45)";
  const goalFormat = (pref as any)?.format || "{current} / {target}";

  const [currentCount, setCurrent] = React.useState(0);

  const compute = React.useCallback(() => {
    const text = editorRef.current?.innerText ?? "";
    const n =
      goalMode === "chars"
        ? text.replace(/\s+/g, "").length
        : text.trim().split(/\s+/).filter(Boolean).length;
    setCurrent(n);
  }, [editorRef, goalMode]);

  // 모드/설정 변경 시 재계산
  React.useEffect(() => {
    compute();
  }, [compute]);

  return {
    goalEnabled,
    goalMode,
    goalTarget,
    currentCount,
    quiet,
    goalFormat,
    bumpGoal: compute, // 외부 이벤트에서 호출
  };
}
