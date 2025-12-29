// src/shared/defaultPrefs.ts
export type FontTriplet = {
  name: string;
  style: string;
  size: number;
};

export type Preferences = {
  workingFolder: string;
  autosave: boolean;
  autosaveIntervalSec: number;
  language: "ko" | "en";
  inputLocale: string; // "auto" | "en" | "ko" | "zh-hans" | ...
  theme: "dark" | "light";
  typeface: {
    headline: FontTriplet;
    body: FontTriplet;
    accent: FontTriplet;
    etc: FontTriplet;
  };
  accentColor: string;
  bracket: {
    enable: boolean;
    style: "none" | "doubleCorner" | "doubleAngle" | "singleCorner" | "singleAngle";
  };
  writingGoal: {
    enabled: boolean;
    unit: "chars" | "words";
    target: number;
  };
};

// 👉 Preset 파일에 저장될 서브셋 (Theme 포함)
export type SplitwriterPrefs = Pick<
  Preferences,
  | "workingFolder"
  | "autosave"
  | "autosaveIntervalSec"
  | "typeface"
  | "accentColor"
  | "writingGoal"
  | "bracket"
  | "theme"
>;

// UI 라벨과 내부 값(실제 font-family 스택) 분리
export const SYSTEM_LABEL = "System UI (auto)";
export const SYSTEM_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// 시스템 기본값 (값은 STACK을 저장)
export const DEFAULT_PREFS: Preferences = {
  workingFolder: "",
  autosave: true,
  autosaveIntervalSec: 60,
  language: "en",
  inputLocale: "auto",
  theme: "dark",
  typeface: {
    headline: { name: SYSTEM_STACK, style: "Regular", size: 22 },
    body:     { name: SYSTEM_STACK, style: "Regular", size: 15 },
    accent:   { name: SYSTEM_STACK, style: "Regular", size: 16 },
    etc:      { name: SYSTEM_STACK, style: "Regular", size: 13 },
  },
  accentColor: "#2AA4FF",
  bracket: { enable: false, style: "none" },
  writingGoal: { enabled: false, unit: "chars", target: 5000 },
};

export default DEFAULT_PREFS;
