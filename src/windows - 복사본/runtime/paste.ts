// src/windows/runtime/paste.ts
export type Preset = 1 | 2 | 3 | 4;
export type Align = "" | "left" | "center" | "right" | "justify";

/** Minimal HTML escaping for plain text. */
export function escapeHTML(s: string) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/**
 * Plain text → Splitwriter paragraph HTML.
 * - Preserves blank lines
 * - Default preset = 2
 * - Default text-align = justify
 */
export function plaintextToParagraphHTML(
  text: string,
  preset: Preset = 2,
  defaultAlign: Exclude<Align, ""> = "justify"
) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const body = lines.map(line => {
    if (line.trim() === "")
      return `<p data-sw-paragraph="1" class="sw-preset-${preset}" style="text-align:${defaultAlign}"><br></p>`;
    return `<p data-sw-paragraph="1" class="sw-preset-${preset}" style="text-align:${defaultAlign}">${escapeHTML(line)}</p>`;
  }).join("");
  return body;
}

/**
 * Sanitize internal HTML (copied from our editor):
 * - Keep preset class
 * - Allow only BR/B/I/STRONG/EM
 * - Keep text-align only when allowAlign === true
 */
export function sanitizeInternalHTML(html: string, allowAlign: boolean) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body;
  const paras = root.querySelectorAll<HTMLElement>("[data-sw-paragraph]");
  if (!paras.length) return "";

  paras.forEach(p => {
    // keep only sw-preset-[1-4]
    const preset = (Array.from(p.classList).find(c => /^sw-preset-[1-4]$/.test(c)) || "sw-preset-2");
    p.className = preset;

    // align
    const ta = (p as HTMLElement).style?.textAlign?.trim() || "";
    (p as HTMLElement).setAttribute("style", allowAlign && ta ? `text-align:${ta}` : "");

    // allow BR/B/I/STRONG/EM only
    const tmp = doc.createElement("div");
    tmp.innerHTML = p.innerHTML;
    const walk = (node: Node): string => {
      if (node.nodeType === 3) return (node as Text).data;
      if (node.nodeType !== 1) return "";
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") return "<br>";
      if (/^(b|strong|i|em)$/.test(tag)) {
        return `<${tag}>${Array.from(el.childNodes).map(walk).join("")}</${tag}>`;
      }
      return Array.from(el.childNodes).map(walk).join("");
    };

    const clean = Array.from(tmp.childNodes).map(walk).join("");
    p.innerHTML = clean || "<br>";
    p.setAttribute("data-sw-paragraph", "1");
  });

  return root.innerHTML;
}

/** Internal clipboard format (JSON) — private to Splitwriter. */
export type SwonClipboard = {
  v: 1,
  paras: { preset: Preset; align?: Align; html: string }[];
};

/** JSON → Splitwriter paragraph HTML */
export function decodeSwonClipboard(json: string) {
  let data: SwonClipboard | null = null;
  try { data = JSON.parse(json) as SwonClipboard; } catch { return ""; }
  if (!data || data.v !== 1 || !Array.isArray(data.paras)) return "";

  return data.paras.map(x => {
    const align: Align = x.align ?? "";                 // avoid TS2367 by normalizing first
    const ta = align ? ` style="text-align:${align}"` : "";
    return `<p data-sw-paragraph="1" class="sw-preset-${x.preset}"${ta}>${x.html || "<br>"}</p>`;
  }).join("");
}
