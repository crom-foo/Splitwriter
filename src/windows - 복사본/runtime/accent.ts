// src/windows/runtime/accent.ts
export function normalizeHex6(s: string, fallback = "#2AA4FF"): string {
  const m = (s || "").trim().match(/^#([0-9A-Fa-f]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
}

/** 런타임 토큰 적용: CSS 변수만 건드린다. */
export function applyAccentTokens(hex: string) {
  const acc = normalizeHex6(hex);
  const root = document.documentElement.style;
  root.setProperty("--accent", acc);
  root.setProperty("--accent-25", hexA(acc, 0.25));
  root.setProperty("--accent-40", hexA(acc, 0.40));
}

/** 현재 토큰에서 읽기(필요할 때 사용) */
export function getAccentFromDOM(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v || "#2AA4FF";
}
