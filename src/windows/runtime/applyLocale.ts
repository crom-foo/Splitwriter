// runtime/applyLocale.ts
import { resolveInputLocale } from "./locale";

/**
 * Set the document language hint without changing the UI direction.
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
