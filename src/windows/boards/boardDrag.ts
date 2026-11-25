export type BoardGroup = "writing" | "notes";
export type NavigatorBoardDrag = { boardId: string; group: BoardGroup };
export type NavigatorGroupDrag = { groupId: string; group: BoardGroup };

let activeNavigatorBoardDrag: NavigatorBoardDrag | null = null;
let activeNavigatorGroupDrag: NavigatorGroupDrag | null = null;

declare global {
  interface Window {
    __SW_NAVIGATOR_BOARD_DRAG__?: NavigatorBoardDrag | null;
    __SW_NAVIGATOR_GROUP_DRAG__?: NavigatorGroupDrag | null;
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
  activeNavigatorGroupDrag = null;
  window.__SW_NAVIGATOR_BOARD_DRAG__ = item;
  window.__SW_NAVIGATOR_GROUP_DRAG__ = null;
  transfer.effectAllowed = "move";
  transfer.setData(boardDragType(item.group), JSON.stringify(item));
  transfer.setData("text/plain", `splitwriter-board|${item.group}|${encodeURIComponent(item.boardId)}`);
}

export function beginNavigatorGroupDrag(transfer: DataTransfer, item: NavigatorGroupDrag) {
  activeNavigatorGroupDrag = item;
  activeNavigatorBoardDrag = null;
  window.__SW_NAVIGATOR_GROUP_DRAG__ = item;
  window.__SW_NAVIGATOR_BOARD_DRAG__ = null;
  transfer.effectAllowed = "move";
  transfer.setData("application/x-splitwriter-group", JSON.stringify(item));
  transfer.setData("text/plain", `splitwriter-group|${item.group}|${encodeURIComponent(item.groupId)}`);
}

export function endNavigatorBoardDrag() {
  activeNavigatorBoardDrag = null;
  activeNavigatorGroupDrag = null;
  window.__SW_NAVIGATOR_BOARD_DRAG__ = null;
  window.__SW_NAVIGATOR_GROUP_DRAG__ = null;
}

export const endNavigatorGroupDrag = endNavigatorBoardDrag;

export function hasActiveNavigatorBoardDrag(): boolean {
  return activeNavigatorBoardDrag !== null || !!window.__SW_NAVIGATOR_BOARD_DRAG__;
}

export function hasActiveNavigatorGroupDrag(): boolean {
  return activeNavigatorGroupDrag !== null || !!window.__SW_NAVIGATOR_GROUP_DRAG__;
}

export function readNavigatorGroupDrag(transfer: DataTransfer): NavigatorGroupDrag | null {
  const payload = transfer.getData("application/x-splitwriter-group");
  if (payload) {
    try {
      const value = JSON.parse(payload);
      if (typeof value?.groupId === "string" && value.groupId && (value.group === "writing" || value.group === "notes")) {
        return { groupId: value.groupId, group: value.group };
      }
    } catch {}
  }
  const plainText = transfer.getData("text/plain");
  const match = plainText.match(/^splitwriter-group\|(writing|notes)\|(.+)$/);
  if (match) {
    try {
      return { group: match[1] as BoardGroup, groupId: decodeURIComponent(match[2]) };
    } catch {}
  }
  return window.__SW_NAVIGATOR_GROUP_DRAG__ || activeNavigatorGroupDrag;
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
