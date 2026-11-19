import React from "react";

type Props = {
  boardIds: string[];
  gapLines?: number;
  getHTML: (id: string) => string;
  getBoardName: (id: string) => string;
  onExportTxt: () => void;
  onExportPdf: () => void;
};

function cleanHTML(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source || "";
  const allowed = new Set(["P", "SPAN", "BR", "B", "STRONG", "I", "EM", "U"]);
  template.content.querySelectorAll("script,style,iframe,object,embed,svg,math").forEach((node) => node.remove());
  Array.from(template.content.querySelectorAll("*"))
    .reverse()
    .forEach((element) => {
      if (!allowed.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        return;
      }
      const textAlign = element.tagName === "P"
        ? (element as HTMLElement).style.textAlign
        : "";
      const isPresetParagraph = element.tagName === "P" && element.hasAttribute("data-sw-paragraph");
      const presetClass = isPresetParagraph
        ? Array.from(element.classList).find((name) => /^sw-preset-[1-4]$/.test(name))
        : undefined;
      const fontWeight = element.tagName === "SPAN"
        ? (element as HTMLElement).style.fontWeight
        : "";
      const fontStyle = element.tagName === "SPAN"
        ? (element as HTMLElement).style.fontStyle
        : "";
      const scenarioBlock = element.tagName === "P" ? element.getAttribute("data-scenario-block") : null;
      const scenarioPlaceholder = element.tagName === "P" ? element.getAttribute("data-scenario-placeholder") : null;
      const scenarioPart = element.tagName === "SPAN" ? element.getAttribute("data-scenario-part") : null;
      const scenarioPartPlaceholder = element.tagName === "SPAN" ? element.getAttribute("data-scenario-placeholder") : null;
      const isFixedScenarioSeparator = scenarioPart === "separator";
      Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name));
      const style: string[] = [];
      if (["left", "center", "right", "justify"].includes(textAlign)) style.push(`text-align:${textAlign}`);
      if (["bold", "bolder", "600", "700", "800", "900"].includes(fontWeight)) style.push("font-weight:bold");
      if (["italic", "oblique"].includes(fontStyle)) style.push("font-style:italic");
      if (isPresetParagraph) {
        element.setAttribute("data-sw-paragraph", "");
        if (presetClass) element.classList.add(presetClass);
      }
      if (scenarioBlock) element.setAttribute("data-scenario-block", scenarioBlock);
      if (scenarioPlaceholder) element.setAttribute("data-scenario-placeholder", scenarioPlaceholder);
      if (scenarioPart) element.setAttribute("data-scenario-part", scenarioPart);
      if (scenarioPartPlaceholder) element.setAttribute("data-scenario-placeholder", scenarioPartPlaceholder);
      if (isFixedScenarioSeparator) element.setAttribute("contenteditable", "false");
      if (style.length) element.setAttribute("style", style.join(";"));
    });

  // In Manuscript View, a board's trailing blank paragraphs and final soft
  // breaks add empty space that is already represented by the configured gap
  // between boards. Keep them in the source TextBoard, but omit them here.
  let lastParagraph = template.content.lastElementChild;
  while (lastParagraph?.tagName === "P") {
    while (lastParagraph.lastElementChild?.tagName === "BR") {
      lastParagraph.lastElementChild.remove();
    }
    if ((lastParagraph.textContent || "").trim() !== "") break;
    const previous = lastParagraph.previousElementSibling;
    lastParagraph.remove();
    lastParagraph = previous;
  }

  // Keep intentional spacebar indentation and repeated spaces without treating
  // literal newlines inside text nodes as hard line breaks. Enter is represented
  // by paragraph/BR elements in the editor, so raw newlines should collapse.
  const textWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  while (textWalker.nextNode()) {
    const node = textWalker.currentNode as Text;
    const normalized = (node.nodeValue || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]*\n[ \t]*/g, " ");
    node.nodeValue = normalized.replace(/(^ +| {2,})/g, (spaces) => "\u00a0".repeat(spaces.length));
  }
  return template.innerHTML;
}

export default function ManuscriptBoard({ boardIds, gapLines = 1, getHTML, getBoardName, onExportTxt, onExportPdf }: Props) {
  const [revision, setRevision] = React.useState(0);
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);
  const [currentBoardId, setCurrentBoardId] = React.useState<string | null>(boardIds[0] ?? null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const boardSectionRefs = React.useRef(new Map<string, HTMLElement>());
  const boardIdsRef = React.useRef(boardIds);
  boardIdsRef.current = boardIds;

  React.useEffect(() => {
    let timer: number | undefined;
    const onTextChange = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id && !boardIds.includes(id)) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setRevision((value) => value + 1), 120);
    };
    window.addEventListener("sw:text-content-change", onTextChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("sw:text-content-change", onTextChange);
    };
  }, [boardIds]);

  const updateCurrentBoard = React.useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const readingY = rect.top + rect.height / 2;
    let nearestId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const id of boardIdsRef.current) {
      const section = boardSectionRefs.current.get(id);
      if (!section) continue;
      const sectionRect = section.getBoundingClientRect();
      if (sectionRect.top <= readingY && sectionRect.bottom >= readingY) {
        nearestId = id;
        break;
      }
      const distance = readingY < sectionRect.top
        ? sectionRect.top - readingY
        : readingY - sectionRect.bottom;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }
    setCurrentBoardId((previous) => previous === nearestId ? previous : nearestId);
  }, []);

  React.useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", updateCurrentBoard, { passive: true });
    window.addEventListener("resize", updateCurrentBoard);
    updateCurrentBoard();
    return () => {
      scroller.removeEventListener("scroll", updateCurrentBoard);
      window.removeEventListener("resize", updateCurrentBoard);
    };
  }, [updateCurrentBoard]);

  React.useEffect(() => {
    updateCurrentBoard();
  }, [boardIds, revision, updateCurrentBoard]);

  return (
    <section
      aria-label="Manuscript View"
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--text-1)",
      }}
    >
      <header
        style={{
          position: "relative",
          height: 31,
          flex: "0 0 31px",
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          justifyContent: "space-between",
          borderBottom: 0,
          boxSizing: "border-box",
        }}
      >
        <div aria-hidden="true" style={{ position: "absolute", left: 0, right: 10, bottom: 0, height: 1, background: "var(--pane-divider, var(--border))" }} />
        <span
          style={{
            height: 18,
            display: "flex",
            alignItems: "center",
            paddingLeft: 10,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".08em",
            color: "var(--text-muted)",
          }}
        >
          MANUSCRIPT VIEW
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {currentBoardId && <span
            title={getBoardName(currentBoardId)}
            aria-live="polite"
            style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-muted)" }}
          >{getBoardName(currentBoardId)}</span>}
          <div style={{ position: "relative", flex: "0 0 auto" }}>
          <button type="button" title="Export manuscript" aria-label="Export manuscript" aria-expanded={exportMenuOpen}
            onClick={() => setExportMenuOpen((open) => !open)}
            style={{ width: 25, height: 25, display: "grid", placeItems: "center", border: "1px solid transparent", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7m0 0 2.5-2.5M8 9.5 5.5 7M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {exportMenuOpen && <>
            <button aria-label="Close export menu" onClick={() => setExportMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20, border: 0, padding: 0, background: "transparent" }} />
            <div role="menu" style={{ position: "absolute", zIndex: 21, top: 28, right: 0, minWidth: 112, padding: 4, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 4px 14px rgba(0,0,0,.14)" }}>
              {([ ["TXT", onExportTxt], ["PDF", onExportPdf] ] as const).map(([label, action]) => <button key={label} role="menuitem" onClick={() => { setExportMenuOpen(false); action(); }} style={{ display: "block", width: "100%", padding: "7px 9px", border: 0, borderRadius: 5, textAlign: "left", background: "transparent", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>{label}</button>)}
            </div>
          </>}
          </div>
        </div>
      </header>
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
        }}
        ref={scrollRef}
      >
        <div
          style={{
            boxSizing: "border-box",
            minHeight: "100%",
            padding: "34px 24px 32px",
            fontFamily: "var(--type-b-family, system-ui)",
            fontSize: "var(--type-b-size, 16px)",
            background: "var(--bg)",
          }}
        >
          <article
            key={revision}
            style={{
              width: "100%",
              maxWidth: 920,
              minHeight: "100%",
              boxSizing: "border-box",
              margin: "0 auto",
              padding: "0 16px",
              lineHeight: 1.65,
            }}
          >
            {boardIds.map((id) => (
              <section
                key={id}
                ref={(element) => {
                  if (element) boardSectionRefs.current.set(id, element);
                  else boardSectionRefs.current.delete(id);
                }}
                dangerouslySetInnerHTML={{ __html: cleanHTML(getHTML(id)) }}
                style={{ marginBottom: `${Math.max(0, gapLines) * 1.65}em`, overflowWrap: "anywhere" }}
              />
            ))}
          </article>
        </div>
        <style>{`[aria-label="Manuscript View"] p { margin: 0; }`}</style>
      </div>
    </section>
  );
}
