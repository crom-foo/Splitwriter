const PAGED_POLYFILL = "/vendor/paged.polyfill.js";

// Render the printable document in an offscreen iframe and open only the
// WebView/Windows native print dialog.
export type PrintOptions = {
  page?: "A4" | "Letter";
  marginMm?: number | { top: number; right: number; bottom: number; left: number };
  baseFont?: { family: string; sizePx: number };
  title?: string;
  usePaged?: boolean;
  onlyPageNumber?: boolean;
  /** 기본 true. */
  autoPrint?: boolean;
};

const esc = (s: any) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escAttr = (s: any) =>
  esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const mm = (n: number) => `${n}mm`;

type PrintAlign = "" | "left" | "center" | "right" | "justify";

function normAlign(a?: string | null, el?: HTMLElement): PrintAlign {
  const v = (a || "").toLowerCase();
  if (v === "left" || v === "center" || v === "right" || v === "justify") return v as any;
  if (v === "l") return "left";
  if (v === "c") return "center";
  if (v === "r") return "right";
  if (v === "j") return "justify";
  try {
    const css = (el ? getComputedStyle(el).textAlign : "").toLowerCase();
    if (css === "left" || css === "center" || css === "right" || css === "justify") return css as any;
  } catch {}
  return "";
}

function styleFromComputed(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const s: string[] = [];
  if (cs.fontFamily) s.push(`font-family:${cs.fontFamily}`);
  if (cs.fontSize) s.push(`font-size:${cs.fontSize}`);
  if (cs.fontWeight) s.push(`font-weight:${cs.fontWeight}`);
  if (cs.fontStyle && cs.fontStyle !== "normal") s.push(`font-style:${cs.fontStyle}`);
  if (cs.lineHeight && cs.lineHeight !== "normal") s.push(`line-height:${cs.lineHeight}`);
  return s.join("; ");
}

function findActiveEditorRoot(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const board = active?.closest?.("[data-board-id]") as HTMLElement | null;
  const inBoard = board?.querySelector?.(
    '[data-role="editor-root"], [data-sw-editor-root], [data-sw-editor], [contenteditable="true"]'
  ) as HTMLElement | null;
  if (inBoard) return inBoard;

  return document.querySelector(
    '[data-role="editor-root"], [data-sw-editor-root], [data-sw-editor], [data-board-id] [contenteditable="true"]'
  ) as HTMLElement | null;
}

/* -------- Fallback: grab content from active editor -------- */
function grabFromActiveEditorHTML(): string {
  const root = findActiveEditorRoot();
  if (!root) return "";

  const paras = root.querySelectorAll("[data-sw-paragraph]");
  const out: string[] = [];

  paras.forEach((p) => {
    const el = p as HTMLElement;
    const preset = getPresetFrom(el);
    const align = normAlign(el.getAttribute("data-align"), el);
    const dup = el.cloneNode(true) as HTMLElement;

    dup.removeAttribute("contenteditable");
    dup.removeAttribute("data-sel-start");
    dup.removeAttribute("data-sel-end");
    dup.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));

    const inline = styleFromComputed(el);
    out.push(
      `<div data-sw-paragraph data-preset="${preset}"${align ? ` data-align="${align}"` : ""} style="${escAttr(inline)}">${dup.innerHTML}</div>`
    );
  });

  return out.join("");
}

function getPresetFrom(el: HTMLElement): "1" | "2" | "3" | "4" {
  const byAttr = (el.getAttribute("data-preset") || "").trim();
  if (byAttr === "1" || byAttr === "2" || byAttr === "3" || byAttr === "4") return byAttr as any;

  for (const c of el.classList) {
    const m = /^sw-preset-(\d)$/.exec(c);
    if (m && (m[1] === "1" || m[1] === "2" || m[1] === "3" || m[1] === "4")) return m[1] as any;
  }
  return "2";
}

function fontCSSFromPrefs(): string {
  try {
    const raw = localStorage.getItem("splitwriter:preferences:v4");
    if (!raw) return "";

    const p = JSON.parse(raw);
    const tf = p?.typeface || {};
    const fam = (x: any) => String(x?.name || "system-ui").replace(/"/g, '\\"');
    const size = (x: any) => Number(x?.size || 16);
    const weight = (x: any) => {
      const s = String(x?.style || "").toLowerCase();
      if (s.includes("black")) return 900;
      if (s.includes("extra") && s.includes("bold")) return 800;
      if (s.includes("bold")) return 700;
      if (s.includes("semibold") || s.includes("demibold")) return 600;
      if (s.includes("medium")) return 500;
      if (s.includes("light")) return 300;
      return 400;
    };
    const italic = (x: any) => /italic|oblique/i.test(String(x?.style || ""));

    const rule = (n: 1 | 2 | 3 | 4, slot: any) =>
      `.sw-print-root [data-sw-paragraph][data-preset="${n}"],
       .sw-print-root [data-sw-paragraph].sw-preset-${n}{
          font-family:"${fam(slot)}", system-ui !important;
          font-size:${size(slot)}px !important;
          font-weight:${weight(slot)} !important;
          ${italic(slot) ? "font-style:italic !important;" : ""}
       }`;

    return [rule(1, tf.headline), rule(2, tf.body), rule(3, tf.accent), rule(4, tf.etc)].join("\n");
  } catch {
    return "";
  }
}

function fontCSSFromCSSVars(): string {
  const r = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => r.getPropertyValue(name).trim() || fb;

  const H = { fam: v("--type-h-family", "system-ui"), size: v("--type-h-size", "16px"), line: v("--type-h-line", "24px"), style: v("--type-h-style", "normal"), indent: v("--sw-indent-headline", "0px") };
  const B = { fam: v("--type-b-family", "system-ui"), size: v("--type-b-size", "16px"), line: v("--type-b-line", "24px"), style: v("--type-b-style", "normal"), indent: v("--sw-indent-body", "0px") };
  const A = { fam: v("--type-a-family", "system-ui"), size: v("--type-a-size", "16px"), line: v("--type-a-line", "24px"), style: v("--type-a-style", "normal"), indent: v("--sw-indent-accent", "0px") };
  const E = { fam: v("--type-e-family", "system-ui"), size: v("--type-e-size", "16px"), line: v("--type-e-line", "24px"), style: v("--type-e-style", "normal"), indent: v("--sw-indent-etc", "0px") };

  const rule = (n: 1 | 2 | 3 | 4, o: any) =>
    `.sw-print-root [data-sw-paragraph][data-preset="${n}"],
     .sw-print-root [data-sw-paragraph].sw-preset-${n}{
        font-family:${o.fam} !important;
        font-size:${o.size} !important;
        line-height:${o.line} !important;
        text-indent:${o.indent} !important;
        ${o.style !== "normal" ? `font-style:${o.style} !important;` : ""}
     }`;

  return [rule(1, H), rule(2, B), rule(3, A), rule(4, E)].join("\n");
}

function buildPrintableHTML(inner: string, opts: Required<Omit<PrintOptions, "marginMm">> & { marginMm: NonNullable<PrintOptions["marginMm"]> }) {
  const m =
    typeof opts.marginMm === "number"
      ? { top: opts.marginMm, right: opts.marginMm, bottom: opts.marginMm, left: opts.marginMm }
      : opts.marginMm;

  const baseFamily = esc(opts.baseFont.family || "system-ui");
  const baseSize = Number(opts.baseFont.sizePx || 16);

  const css = `
  @page { size: ${opts.page}; margin: ${mm(m.top)} ${mm(m.right)} ${mm(m.bottom)} ${mm(m.left)}; }
  :root { color-scheme: light; }
  html, body {
    margin:0; padding:0; background:#fff !important; color:#111 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    font-family:${baseFamily}; font-size:${baseSize}px; line-height:1.6;
  }

  .sw-print-root { all: revert; display:block; background:#fff !important; color:#111 !important; }
  .sw-print-root * {
    color: inherit !important;
    -webkit-text-fill-color: currentColor !important;
    box-sizing: border-box;
  }

  .sw-print-root b, .sw-print-root strong { font-weight:700 !important; }
  .sw-print-root i, .sw-print-root em { font-style:italic !important; }

  .sw-print-root [data-align="left"],
  .sw-print-root [data-align="l"] { text-align:left !important; }
  .sw-print-root [data-align="center"],
  .sw-print-root [data-align="c"] { text-align:center !important; }
  .sw-print-root [data-align="right"],
  .sw-print-root [data-align="r"] { text-align:right !important; }
  .sw-print-root [data-align="justify"],
  .sw-print-root [data-align="j"] { text-align:justify !important; }

  .sw-print-root [data-sw-paragraph] {
    display:block;
    white-space:pre-wrap;
    margin:0 0 12px;
    break-inside:avoid;
    page-break-inside:avoid;
  }

  .sw-print-root [data-scenario-block="scene-heading"] { margin:1.25em 0 1em; font-weight:700; text-transform:uppercase; }
  .sw-print-root [data-scenario-block="scene-heading"]:not(:has([data-scenario-part]:not(:empty))),
  .sw-print-root [data-scenario-block]:is(:empty, :has(> br:only-child)) { display:none; }
  .sw-print-root [data-scenario-block="action"] { margin-bottom:1em; }
  .sw-print-root [data-scenario-block="character"] { width:64%; margin:1em 0 0 18%; font-weight:700; text-transform:uppercase; }
  .sw-print-root [data-scenario-block="dialogue"] { width:64%; margin:0 0 1em 18%; text-align:left !important; }
  .sw-print-root [data-scenario-block="parenthetical"] { width:54%; margin:0 0 0 23%; text-align:left !important; }
  .sw-print-root [data-scenario-block="parenthetical"]:has(> br:only-child) { display:none; }
  .sw-print-root [data-scenario-part="scene-number"]:empty { display:none; }
  .sw-print-root [data-scenario-part="scene-number"]:not(:empty)::after { content:". "; }
  .sw-print-root [data-scenario-part="location"]::after { content:" - "; }
  .sw-print-root [data-scenario-block="transition"] { margin:1.25em 0; font-weight:650; text-transform:uppercase; }

  img { max-width:100%; height:auto; }

  ${fontCSSFromCSSVars()}
  ${fontCSSFromPrefs()}

  ${
    opts.usePaged && opts.onlyPageNumber
      ? `@page { @bottom-right { content: counter(page); font: 12px ${baseFamily}; color:#666; } }`
      : ""
  }
  `;

  const paged = opts.usePaged ? `<script src="${PAGED_POLYFILL}"></script>` : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(opts.title)}</title>
<style>${css}</style>
${paged}
</head>
<body>
  <article class="sw-print-root">${inner}</article>
</body>
</html>`;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForFontsAndImages(doc: Document, timeoutMs = 1400) {
  const jobs: Promise<any>[] = [];

  try {
    const fonts = (doc as any).fonts;
    if (fonts?.ready) jobs.push(Promise.race([fonts.ready, wait(timeoutMs)]));
  } catch {}

  try {
    const imgs = Array.from(doc.images || []);
    if (imgs.length) {
      jobs.push(
        Promise.race([
          Promise.all(
            imgs.map((img) => {
              if ((img as HTMLImageElement).complete) return Promise.resolve();
              return new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              });
            })
          ),
          wait(timeoutMs),
        ])
      );
    }
  } catch {}

  await Promise.all(jobs);
}

function waitForPaged(doc: Document, enabled: boolean, timeoutMs = 1600) {
  if (!enabled) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { doc.removeEventListener("pagedjs:rendered", finish as any); } catch {}
      resolve();
    };

    try { doc.addEventListener("pagedjs:rendered", finish as any, { once: true }); } catch {}
    window.setTimeout(finish, timeoutMs);
  });
}

function notifyPrintMessage(type: "SW_PRINT_OPENING" | "SW_PRINT_CLOSED" | "SW_PRINT_FAILED") {
  try { window.postMessage({ who: "splitwriter", type }, "*"); } catch {}
}

function notifyPrintDone() {
  try { window.postMessage({ __sw_print_done__: true }, "*"); } catch {}
}

function removePreviousPrintHost() {
  document.querySelectorAll('[data-sw-print-host="1"]').forEach((el) => {
    try { el.remove(); } catch {}
  });
}

export function printHTML(getHTML: () => string, opts: PrintOptions = {}) {
  const resolved = {
    page: opts.page ?? "A4",
    marginMm: opts.marginMm ?? 18,
    baseFont: opts.baseFont ?? { family: "system-ui", sizePx: 16 },
    title: opts.title ?? "Splitwriter",
    usePaged: opts.usePaged ?? true,
    onlyPageNumber: opts.onlyPageNumber ?? true,
    autoPrint: opts.autoPrint ?? true,
  };

  let inner = "";
  try { inner = getHTML?.() || ""; } catch { inner = ""; }
  if (!/\S/.test(inner)) inner = grabFromActiveEditorHTML();
  if (!/\S/.test(inner)) {
    inner = '<div style="padding:24px;font:14px system-ui;color:#111">[Splitwriter] Empty content.</div>';
  }

  const html = buildPrintableHTML(inner, resolved);

  removePreviousPrintHost();

  const frame = document.createElement("iframe");
  frame.setAttribute("title", "Splitwriter print document");
  frame.setAttribute("data-sw-print-host", "1");
  frame.style.cssText = [
    "position:fixed",
    "left:-12000px",
    "top:0",
    "width:210mm",
    "height:297mm",
    "border:0",
    "background:#fff",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(frame);

  let closed = false;
  let printing = false;
  let autoTried = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { frame.contentWindow?.removeEventListener("afterprint", onAfterPrint as any); } catch {}
    try { window.removeEventListener("afterprint", onAfterPrint as any); } catch {}
    try { frame.remove(); } catch {}
    notifyPrintMessage("SW_PRINT_CLOSED");
    notifyPrintDone();
  };

  const onAfterPrint = () => {
    // afterprint는 다이얼로그가 닫힌 직후 들어온다.
    window.setTimeout(cleanup, 80);
  };

  const doPrint = async () => {
    if (closed || printing) return;
    printing = true;
    notifyPrintMessage("SW_PRINT_OPENING");

    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) throw new Error("print frame is not ready");

      await waitForFontsAndImages(doc);
      try { win.focus(); } catch {}
      try { win.print(); } catch (err) { throw err; }
    } catch (err) {
      console.error("[Splitwriter] print failed:", err);
      printing = false;
      notifyPrintMessage("SW_PRINT_FAILED");
      cleanup();
    }
  };

  frame.onload = async () => {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win || closed) return;

    try { win.addEventListener("afterprint", onAfterPrint as any); } catch {}
    try { window.addEventListener("afterprint", onAfterPrint as any); } catch {}

    await waitForPaged(doc, !!resolved.usePaged);
    await waitForFontsAndImages(doc);

    if (resolved.autoPrint && !autoTried && !closed) {
      autoTried = true;
      // Let the document finish layout before opening the native print dialog.
      window.setTimeout(() => { void doPrint(); }, 80);
    }
  };

  frame.srcdoc = html;
}
