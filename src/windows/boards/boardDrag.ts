export type BoardGroup = "writing" | "notes";
export type NavigatorBoardDrag = { boardId: string; group: BoardGroup };

let activeNavigatorBoardDrag: NavigatorBoardDrag | null = null;

declare global {
  interface Window {
    __SW_NAVIGATOR_BOARD_DRAG__?: NavigatorBoardDrag | null;
  }
}

export function boardDragType(group: BoardGroup): string {
  return `application/x-splitwriter-${group}-board`;
}

export function beginNavigatorBoardDrag(
  transfer: DataTransfer,
  item: NavigatorBoardDrag,
) {
  activeNavigatorBoardDrag = item;
  window.__SW_NAVIGATOR_BOARD_DRAG__ = item;
  transfer.effectAllowed = "move";
  transfer.setData(boardDragType(item.group), JSON.stringify(item));
  transfer.setData("text/plain", `splitwriter-board|${item.group}|${encodeURIComponent(item.boardId)}`);
}

export function endNavigatorBoardDrag() {
  activeNavigatorBoardDrag = null;
  window.__SW_NAVIGATOR_BOARD_DRAG__ = null;
}

export function hasActiveNavigatorBoardDrag(): boolean {
  return activeNavigatorBoardDrag !== null || !!window.__SW_NAVIGATOR_BOARD_DRAG__;
}

export function readNavigatorBoardDrag(transfer: DataTransfer): NavigatorBoardDrag | null {
  for (const group of ["writing", "notes"] as const) {
    const payload = transfer.getData(boardDragType(group));
    if (!payload) continue;
    try {
      const value = JSON.parse(payload);
      if (typeof value?.boardId === "string" && value.boardId && value.group === group) {
        return { boardId: value.boardId, group };
      }
    } catch {}
  }
  const plainText = transfer.getData("text/plain");
  const match = plainText.match(/^splitwriter-board\|(writing|notes)\|(.+)$/);
  if (match) {
    try {
      return { group: match[1] as BoardGroup, boardId: decodeURIComponent(match[2]) };
    } catch {}
  }
  return window.__SW_NAVIGATOR_BOARD_DRAG__ || activeNavigatorBoardDrag;
}
