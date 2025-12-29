// runtime/applyLocale.ts
import { resolveInputLocale } from "./locale";

/**
 * "키보드 지원" 목적: UI 방향(RTL) 같은 건 건드리지 않고,
 * html lang + data-input-locale 만 세팅 (테스트/접근성/스펠체크 힌트용).
 */
export function applyInputLocaleDom(inputLocale?: any) {
  try {
    const root = document.documentElement;
    const opt = resolveInputLocale(inputLocale);

    if (opt.lang) root.setAttribute("lang", opt.lang);
    else root.removeAttribute("lang");

    // UI에는 영향 거의 없고, 나중에 필요하면 CSS 훅으로도 쓸 수 있음
    root.setAttribute("data-input-locale", opt.id);
  } catch {
    // ignore
  }
}
