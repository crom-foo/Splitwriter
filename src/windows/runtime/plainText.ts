import { normalizeParagraphIndent, type ParagraphIndent } from "../../shared/defaultPrefs";

function paragraphIndentPrefix(element: HTMLElement, value?: ParagraphIndent): string {
  const indent = normalizeParagraphIndent(value);
  if (!indent.enabled || element.hasAttribute("data-sw-copy-partial-start")) return "";
  const preset = Array.from(element.classList).find((name) => /^sw-preset-[1-4]$/.test(name));
  const slot = preset ? Number(preset.slice(-1)) : 2;
  const enabled = slot === 1 ? indent.headline
    : slot === 2 ? indent.body
    : slot === 3 ? indent.accent
    : indent.etc;
  return enabled ? " ".repeat(indent.spaces) : "";
}

/** Prevent synthetic indentation when a clipboard selection starts mid-paragraph. */
export function markPartialSelectionStart(fragment: DocumentFragment, sourceRange: Range): void {
  const startElement = sourceRange.startContainer.nodeType === Node.ELEMENT_NODE
    ? sourceRange.startContainer as Element
    : sourceRange.startContainer.parentElement;
  const sourceParagraph = startElement?.closest("[data-sw-paragraph], p") as HTMLElement | null;
  if (!sourceParagraph) return;

  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(sourceParagraph);
    prefix.setEnd(sourceRange.startContainer, sourceRange.startOffset);
    if (!prefix.toString().length) return;

    const copiedParagraph = fragment.querySelector("[data-sw-paragraph], p") as HTMLElement | null;
    copiedParagraph?.setAttribute("data-sw-copy-partial-start", "1");
  } catch {
    // If the selection cannot be compared safely, retain the normal copy behavior.
  }
}

/** Return the configured indentation profile as it should be materialized on the clipboard. */
export function clipboardParagraphIndent(value?: ParagraphIndent): ParagraphIndent {
  const indent = normalizeParagraphIndent(value);
  return { ...indent, enabled: indent.enabled && indent.copyEnabled };
}

/** Convert editor HTML to plain text while materializing configured first-line indents. */
export function htmlToPlainText(
  root: ParentNode,
  paragraphIndent?: ParagraphIndent,
  paragraphBreak = "\n\n",
): string {
  const readNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (!(node instanceof HTMLElement)) return Array.from(node.childNodes).map(readNode).join("");
    if (node.tagName === "BR") return "\n";

    const content = Array.from(node.childNodes).map(readNode).join("");
    const isParagraph = node.hasAttribute("data-sw-paragraph") || node.tagName === "P" || node.tagName === "DIV";
    if (!isParagraph) return content;
    const prefix = content.trim() ? paragraphIndentPrefix(node, paragraphIndent) : "";
    return `${prefix}${content}${paragraphBreak}`;
  };

  return Array.from(root.childNodes).map(readNode).join("")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}
