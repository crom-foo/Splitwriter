// src/windows/runtime/curly.ts
// Curly-bracket replacement settings & keydown handler

export type CurlyPref =
  | boolean
  | [string, string]
  | { enabled?: boolean; left?: string; right?: string };

export type CurlySetting = { enabled: boolean; left: string; right: string };

/** Normalize user preference into a concrete setting. */
export function normalizeCurly(p?: CurlyPref): CurlySetting {
  if (!p) return { enabled: false, left: "{", right: "}" };
  if (p === true) return { enabled: true, left: "「", right: "」" };
  if (Array.isArray(p))
    return { enabled: true, left: p[0] ?? "{", right: p[1] ?? "}" };
  return {
    enabled: p.enabled !== false,
    left: p.left ?? "「",
    right: p.right ?? "」",
  };
}

/**
 * Intercepts '{' and '}' (typically Shift+[ / Shift+]) and inserts the configured pair.
 * Returns true when handled (insertion performed).
 */
export function handleCurlyKeyDown(
  e: React.KeyboardEvent,
  setting: CurlySetting,
  ensureParagraphs: () => void,
  scheduleSave: () => void,
  afterInsert?: () => void
): boolean {
  if (!setting.enabled) return false;

  const raw = e.key || "";
  const shiftTyping = !e.ctrlKey && !e.metaKey && !e.altKey; // plain typing with optional Shift
  if (!shiftTyping) return false;

  if (raw === "{" || raw === "}") {
    e.preventDefault();
    ensureParagraphs();
    const ch = raw === "{" ? setting.left : setting.right;
    try { document.execCommand("insertText", false, ch); } catch {}
    scheduleSave();
    afterInsert?.();
    return true;
  }
  return false;
}
