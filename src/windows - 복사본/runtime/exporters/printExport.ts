const PAGED_POLYFILL = "/vendor/paged.polyfill.js";

// 안정형 print: hidden <iframe srcdoc> + 단발성 print() 가드
export type PrintOptions = {
  page?: "A4" | "Letter";
  marginMm?: number | { top: number; right: number; bottom: number; left: number };
  baseFont?: { family: string; sizePx: number };
  title?: string;           // 헤더/바닥글 켤 때 머릿글로 찍힐 제목
  usePaged?: boolean;       // 우하단 페이지 번호(1,2,3…) 위해 Paged.js 사용
  onlyPageNumber?: boolean; // x/전체 대신 1,2,3… 만
};

const esc = (s: any) =>
  String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const mm = (n: number) => `${n}mm`;

function normAlign(a?: string | null, el?: HTMLElement): "" | "left" | "center" | "right" {
  const v = (a || "").toLowerCase();
  if (v === "left" || v === "center" || v === "right") return v as any;
  if (v === "l") return "left";
  if (v === "c") return "center";
  if (v === "r") return "right";
  try {
    const css = (el ? getComputedStyle(el).textAlign : "").toLowerCase();
    if (css === "left" || css === "center" || css === "right") return css as any;
  } catch {}
  return "";
}

function styleFromComputed(el: HTMLElement){
  const cs = getComputedStyle(el);
  const s: string[] = [];
  if (cs.fontFamily)  s.push(`font-family:${cs.fontFamily}`);
  if (cs.fontSize)    s.push(`font-size:${cs.fontSize}`);
  if (cs.fontWeight)  s.push(`font-weight:${cs.fontWeight}`);
  if (cs.fontStyle && cs.fontStyle !== "normal") s.push(`font-style:${cs.fontStyle}`);
  if (cs.lineHeight && cs.lineHeight !== "normal") s.push(`line-height:${cs.lineHeight}`);
  return s.join("; ");
}

/* -------- Fallback: grab content from active editor -------- */
function grabFromActiveEditorHTML(): string {
  const root = document.querySelector('[data-sw-editor-root], [data-sw-editor]') as HTMLElement | null;
  if (!root) return "";
  const paras = root.querySelectorAll('[data-sw-paragraph]');
  const out: string[] = [];
  paras.forEach((p) => {
    const el = p as HTMLElement;
    const preset = getPresetFrom(el);
    const align  = normAlign(el.getAttribute("data-align"), el);
    const dup = el.cloneNode(true) as HTMLElement;

    dup.removeAttribute("contenteditable");
    dup.removeAttribute("data-sel-start");
    dup.removeAttribute("data-sel-end");
    dup.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));

    const inline = styleFromComputed(el); // 실제 폰트/사이즈/굵기 반영
    out.push(`<div data-sw-paragraph data-preset="${preset}"${align ? ` data-align="${align}"` : ""} style="${inline}">${dup.innerHTML}</div>`);
  });
  return out.join("");
}

function getPresetFrom(el: HTMLElement): "1"|"2"|"3"|"4" {
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
    const fam = (x:any) => String(x?.name || "system-ui").replace(/"/g, '\\"');
    const size = (x:any) => Number(x?.size || 16);
    const weight = (x:any) => {
      const s = String(x?.style || "").toLowerCase();
      if (s.includes("black")) return 900;
      if (s.includes("extra") && s.includes("bold")) return 800;
      if (s.includes("bold")) return 700;
      if (s.includes("semibold") || s.includes("demibold")) return 600;
      if (s.includes("medium")) return 500;
      if (s.includes("light")) return 300;
      return 400;
    };
    const italic = (x:any) => /italic|oblique/i.test(String(x?.style || "")) ? " font-style:italic;" : "";
    const rule = (n:1|2|3|4, slot:any) =>
    `.sw-print-root [data-sw-paragraph][data-preset="${n}"]{
      font-family:"${fam(slot)}",system-ui !important;
      font-size:${size(slot)}px !important;
      font-weight:${weight(slot)} !important;
      ${italic(slot) ? "font-style:italic !important;" : ""}
    }`;
    return [rule(1, tf.headline), rule(2, tf.body), rule(3, tf.accent), rule(4, tf.etc)].join("\n");
  } catch { return ""; }
}

function fontCSSFromCSSVars(): string {
  const r = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (r.getPropertyValue(name).trim() || fb);

  const H = { fam: v("--type-h-family","system-ui"), size: v("--type-h-size","16px"), line: v("--type-h-line","24px"), style: v("--type-h-style","normal") };
  const B = { fam: v("--type-b-family","system-ui"), size: v("--type-b-size","16px"), line: v("--type-b-line","24px"), style: v("--type-b-style","normal") };
  const A = { fam: v("--type-a-family","system-ui"), size: v("--type-a-size","16px"), line: v("--type-a-line","24px"), style: v("--type-a-style","normal") };
  const E = { fam: v("--type-e-family","system-ui"), size: v("--type-e-size","16px"), line: v("--type-e-line","24px"), style: v("--type-e-style","normal") };

  const rule = (n:1|2|3|4, o:any) =>
    `.sw-print-root [data-sw-paragraph][data-preset="${n}"],
      .sw-print-root [data-sw-paragraph].sw-preset-${n}{
        font-family:${o.fam} !important;
        font-size:${o.size} !important;
        line-height:${o.line} !important;
        ${o.style !== "normal" ? `font-style:${o.style} !important;` : ""}
     }`;

  return [rule(1,H), rule(2,B), rule(3,A), rule(4,E)].join("\n");
}

export function printHTML(getHTML: () => string, opts: PrintOptions = {}) {
  const {
    page = "A4",
    marginMm = 18,
    baseFont = { family: "system-ui", sizePx: 16 },
    title = "Splitwriter",
    usePaged = true,
    onlyPageNumber = true,
  } = opts;

  const m = typeof marginMm === "number"
    ? { top: marginMm, right: marginMm, bottom: marginMm, left: marginMm }
    : marginMm;

  let inner = getHTML() || "";
  if (!/\S/.test(inner)) inner = grabFromActiveEditorHTML();
  if (!/\S/.test(inner)) {
    inner = '<div style="padding:24px;font:14px system-ui;color:#111">[Splitwriter] Empty content.</div>';
  }

  const css = `
  @page { size: ${page}; margin: ${mm(m.top)} ${mm(m.right)} ${mm(m.bottom)} ${mm(m.left)}; }
  :root { color-scheme: light; }             /* 강제 라이트 */
  html, body {
    margin:0; padding:0; background:#fff !important; color:#111 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    font-family:${esc(baseFont.family)}; font-size:${baseFont.sizePx}px; line-height:1.6;
  }
  /* 앱 스타일 완전 차단 + 글자색 보정 */
  .sw-print-root { all: revert; background:#fff !important; color:#111 !important; }
  .sw-print-root * {
    color: inherit !important;
    -webkit-text-fill-color: currentColor !important; /* WebView2에서 드물게 color 무시되는 것 방지 */
    box-sizing: border-box;
  }

  /* 인라인 마크업 보정 + 문단 정렬 */
  .sw-print-root b, .sw-print-root strong { font-weight:700 !important; }
  .sw-print-root i, .sw-print-root em     { font-style:italic !important; }
  .sw-print-root [data-align="left"],
  .sw-print-root [data-align="l"]     { text-align:left   !important; }
  .sw-print-root [data-align="center"],
  .sw-print-root [data-align="c"]     { text-align:center !important; }
  .sw-print-root [data-align="right"],
  .sw-print-root [data-align="r"]     { text-align:right  !important; }

  .sw-print-root [data-sw-paragraph]{ display:block; white-space:pre-wrap; margin:0 0 12px; }

  /* 프리셋(1/2/3/4) 폰트/크기/굵기 — Preferences 기반 */
  ${fontCSSFromCSSVars()}
  ${fontCSSFromPrefs()}

  ${usePaged && onlyPageNumber ? `
    @page { @bottom-right { content: counter(page); font: 12px ${esc(baseFont.family)}; color:#666; } }
  ` : ""}
  `;

  const paged = usePaged ? `<script src="${PAGED_POLYFILL}"></script>` : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/> 
<title>${esc(title)}</title>
<style>${css}</style>
${paged}
</head>
<body>
  <article class="sw-print-root">${inner}</article>
  <script>
  (function () {
    var printed = false;
    var fallbackTimer = null;

    function notify(type){
      try { window.opener && window.opener.postMessage({ who:"splitwriter", type }, "*"); } catch(e){}
    }
    function requestPrint(){
      if (printed) return;
      printed = true;
      notify("SW_PRINT_OPENING");
      try{ window.focus(); }catch(e){}
      setTimeout(function(){ try{ window.print(); }catch(e){} }, 0);
    }
    function cancelFallback(){ if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer = null; } }
    function done(){
      cancelFallback();
      notify("SW_PRINT_CLOSED");
      try{ parent.postMessage({ __sw_print_done__: true }, "*"); }catch(e){}
      setTimeout(function(){ try{ window.close(); }catch(e){} }, 0);
    }

    if (window.Paged) {
      document.addEventListener("pagedjs:rendered", function(){
        cancelFallback();
        requestPrint();
      }, { once:true });
      fallbackTimer = setTimeout(requestPrint, 1200);
    } else {
      if (document.readyState === "complete") requestPrint();
      else window.addEventListener("load", requestPrint, { once:true });
    }

    window.addEventListener("beforeprint", cancelFallback, { once:true });
    window.addEventListener("afterprint", done, { once:true });
    setTimeout(done, 10000);
  })();
  </script>
</body>
</html>`;

  // hidden iframe 생성
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.width = "1";
  frame.style.height = "1";
  frame.style.left = "-9999px";
  frame.style.top = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.setAttribute("aria-hidden", "true");

  // 부모에서 정리
  const cleanup = () => { try { frame.remove(); } catch(e){} };
  function onMsg(ev: any){
    if (ev && ev.data && ev.data.__sw_print_done__) {
      window.removeEventListener("message", onMsg);
      setTimeout(cleanup, 150); // 다이얼로그 닫힘 렌더링 마진
    }
  }
  window.addEventListener("message", onMsg);

  // srcdoc에 바로 주입 → 별도 onload 인쇄 트리거 금지(중복 방지)
  frame.srcdoc = html;
  document.body.appendChild(frame);
}
