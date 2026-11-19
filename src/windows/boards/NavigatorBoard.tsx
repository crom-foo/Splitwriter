import React from "react";
import { createPortal } from "react-dom";
import { beginNavigatorBoardDrag, endNavigatorBoardDrag, hasActiveNavigatorBoardDrag, readNavigatorBoardDrag, type BoardGroup } from "./boardDrag";

export type NavigatorTextItem = {
  id: string;
  label: string;
  group: BoardGroup;
  kind?: "board" | "group";
  collapsed?: boolean;
  children?: NavigatorTextItem[];
  parentGroupId?: string;
  isMain?: boolean;
};
type Props = {
  writing: NavigatorTextItem[];
  notes: NavigatorTextItem[];
  writingVariants: { id: string; name: string }[];
  activeWritingVariantId: string;
  onSelectWritingVariant: (id: string) => void;
  onAddWritingVariant: () => void;
  onRenameWritingVariant: (id: string, name: string) => void;
  onDeleteWritingVariant: (id: string) => void;
  onReorderWritingVariant: (sourceId: string, targetId: string, position: "before" | "after") => void;
  activeId: string | null;
  selectedIds: string[];
  onSelectBoard: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onClearSelection: () => void;
  onSelectionChange: (ids: string[]) => void;
  getBoardLabel?: (id: string) => string;
  onRenameBoard: (id: string, name: string) => void;
  onRenameGroup: (id: string, group: BoardGroup, name: string) => void;
  onDeleteBoard: (id: string, group: BoardGroup) => void;
  onGroupSelected: (ids: string[], group: BoardGroup) => string | null;
  onUngroupSelected: (ids: string[], group: BoardGroup) => string[];
  onToggleGroup: (id: string, group: BoardGroup) => void;
  onMoveBoard: (move: {
    boardId: string; sourceGroup: BoardGroup; targetGroup: BoardGroup;
    targetId: string | null; targetParentGroupId: string | null; position: "before" | "after";
  }) => void;
  accentColor?: string;
  manuscriptOpen: boolean;
  onToggleManuscript: () => void;
  onAddBoard: (group: "writing" | "notes") => void;
  onOpenInMain: (id: string, group: BoardGroup) => void;
};

/** Initial 2.0 Navigator shell: Writing and Notes become ordered board lists later. */
export default function NavigatorBoard({
  writing,
  notes,
  writingVariants,
  activeWritingVariantId,
  onSelectWritingVariant,
  onAddWritingVariant,
  onRenameWritingVariant,
  onDeleteWritingVariant,
  onReorderWritingVariant,
  activeId,
  selectedIds,
  onSelectBoard,
  onClearSelection,
  onSelectionChange,
  getBoardLabel,
  onRenameBoard,
  onRenameGroup,
  onDeleteBoard,
  onGroupSelected,
  onUngroupSelected,
  onToggleGroup,
  onMoveBoard,
  accentColor,
  manuscriptOpen,
  onToggleManuscript,
  onAddBoard,
  onOpenInMain,
}: Props) {
  const [, setContentRevision] = React.useState(0);
  const navigatorRootRef = React.useRef<HTMLElement>(null);
  const [contextMenuOwner, setContextMenuOwner] = React.useState<BoardGroup | null>(null);
  const variantInputRef = React.useRef<HTMLInputElement>(null);
  const suppressVariantClickRef = React.useRef(false);
  const cancelVariantRenameRef = React.useRef(false);
  const [variantMenu, setVariantMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const [editingVariantId, setEditingVariantId] = React.useState<string | null>(null);
  const [editingVariantName, setEditingVariantName] = React.useState("");
  const [draggingVariantId, setDraggingVariantId] = React.useState<string | null>(null);
  const [variantDropHint, setVariantDropHint] = React.useState<{ id: string; position: "before" | "after" } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<
    | { type: "draft"; id: string; name: string }
    | { type: "board"; id: string; name: string; group: BoardGroup }
    | null
  >(null);
  React.useEffect(() => {
    const collectBoardIds = (items: NavigatorTextItem[]): string[] => items.flatMap((item) =>
      item.kind === "group" ? collectBoardIds(item.children || []) : [item.id]);
    const boardIds = new Set([...collectBoardIds(writing), ...collectBoardIds(notes)]);
    const onTextChange = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id && boardIds.has(id)) setContentRevision((revision) => revision + 1);
    };
    window.addEventListener("sw:text-content-change", onTextChange);
    return () => window.removeEventListener("sw:text-content-change", onTextChange);
  }, [writing, notes]);
  React.useEffect(() => {
    if (editingVariantId) variantInputRef.current?.focus();
  }, [editingVariantId]);

  const renderVariantTab = (variant: { id: string; name: string }) => {
    const selected = variant.id === activeWritingVariantId;
    const hint = variantDropHint?.id === variant.id ? variantDropHint.position : null;
    return <div key={variant.id} onDragOver={(event) => {
      if (!draggingVariantId || draggingVariantId === variant.id || variant.id === "main" || draggingVariantId === "main") return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setVariantDropHint({ id: variant.id, position: event.clientX < rect.left + rect.width / 2 ? "before" : "after" });
    }} onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVariantDropHint((current) => current?.id === variant.id ? null : current);
    }} onDrop={(event) => {
      event.preventDefault();
      const sourceId = draggingVariantId || event.dataTransfer.getData("text/plain").replace(/^writing-variant:/, "");
      const rect = event.currentTarget.getBoundingClientRect();
      const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
      if (sourceId && sourceId !== variant.id) onReorderWritingVariant(sourceId, variant.id, position);
      setDraggingVariantId(null);
      setVariantDropHint(null);
      suppressVariantClickRef.current = true;
      window.setTimeout(() => { suppressVariantClickRef.current = false; }, 0);
    }} style={{ position: "relative", flex: "0 0 auto", opacity: draggingVariantId === variant.id ? 0.45 : 1 }}>
      {hint && <span aria-hidden="true" style={{ position: "absolute", zIndex: 2, top: 2, bottom: 2, [hint === "before" ? "left" : "right"]: -2, width: 2, borderRadius: 2, background: accentColor || "var(--accent)" }} />}
      {editingVariantId === variant.id ? <input ref={variantInputRef} value={editingVariantName}
        onChange={(event) => setEditingVariantName(event.target.value)}
        onBlur={() => {
          if (cancelVariantRenameRef.current) { cancelVariantRenameRef.current = false; return; }
          onRenameWritingVariant(variant.id, editingVariantName);
          setEditingVariantId(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelVariantRenameRef.current = true;
            setEditingVariantId(null);
            window.setTimeout(() => { cancelVariantRenameRef.current = false; }, 0);
          }
        }}
        aria-label="Rename order" style={{ width: Math.max(46, variant.name.length * 7 + 14), height: 26, boxSizing: "border-box", border: `1px solid ${accentColor || "var(--accent)"}`, borderRadius: 4, padding: "3px 6px", background: "var(--bg)", color: "var(--text-1)", font: "inherit", fontSize: 11 }} />
        : <button className="navigator-order-tab" type="button" role="tab" aria-selected={selected} draggable={variant.id !== "main"}
          onClick={() => { if (!suppressVariantClickRef.current) onSelectWritingVariant(variant.id); }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setVariantMenu({ id: variant.id, x: event.clientX, y: event.clientY });
          }}
          onDragStart={(event) => {
            if (variant.id === "main") { event.preventDefault(); return; }
            event.dataTransfer.setData("text/plain", `writing-variant:${variant.id}`);
            event.dataTransfer.effectAllowed = "move";
            setDraggingVariantId(variant.id);
          }} onDragEnd={() => { setDraggingVariantId(null); setVariantDropHint(null); }}
          style={{ border: "1px solid transparent", outline: "none", borderRadius: 4, background: selected ? `color-mix(in srgb, ${accentColor || "var(--accent)"} 13%, transparent)` : "transparent", color: selected ? "var(--text-1)" : "var(--text-muted)", padding: "3px 8px", font: "inherit", fontSize: 11, whiteSpace: "nowrap", cursor: variant.id === "main" ? "pointer" : "grab" }}>
          {variant.name}
        </button>}
    </div>;
  };

  return (
    <section
      aria-label="Navigator"
      data-sw-navigator-root="1"
      ref={navigatorRootRef}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT") return;
        if (event.key.toLowerCase() !== "g") return;
        const belongsTo = (items: NavigatorTextItem[], id: string): boolean => items.some((item) =>
          item.id === id || (item.children ? belongsTo(item.children, id) : false));
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && selectedIds.length > 0) {
          const group = selectedIds.every((id) => belongsTo(writing, id)) ? "writing"
            : selectedIds.every((id) => belongsTo(notes, id)) ? "notes" : null;
          if (!group) return;
          event.preventDefault();
          const groupId = onGroupSelected(selectedIds, group);
          if (groupId) requestAnimationFrame(() => {
            navigatorRootRef.current?.querySelector<HTMLElement>(`[data-navigator-item-id="${groupId}"]`)?.focus();
            onSelectionChange([groupId]);
          });
        } else if (event.shiftKey && !event.ctrlKey && !event.metaKey && selectedIds.length > 0) {
          const group = selectedIds.every((id) => belongsTo(writing, id)) ? "writing"
            : selectedIds.every((id) => belongsTo(notes, id)) ? "notes" : null;
          if (!group) return;
          event.preventDefault();
          const expanded = onUngroupSelected(selectedIds, group);
          if (expanded[0]) requestAnimationFrame(() => {
            navigatorRootRef.current?.querySelector<HTMLElement>(`[data-navigator-item-id="${expanded[0]}"]`)?.focus();
            onSelectionChange(expanded);
          });
        }
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) onClearSelection();
      }}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
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
          justifyContent: "space-between",
          padding: "0 10px 0 42px",
          borderBottom: 0,
        }}
      >
        <div aria-hidden="true" style={{ position: "absolute", left: 10, right: 0, bottom: 0, height: 1, background: "var(--pane-divider, var(--border))" }} />
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
          NAVIGATOR
        </span>
        <NavigatorIconButton
          title={manuscriptOpen ? "Close Manuscript View" : "Open Manuscript View"}
          onClick={onToggleManuscript}
          icon={
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              style={{ transform: manuscriptOpen ? "rotate(180deg)" : undefined }}
            >
              <path d="M2.5 8h10m-4-4 4 4-4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
      </header>
      <div style={{ minHeight: 0, overflow: "auto", padding: "8px 8px 10px" }}>
        <div role="tablist" aria-label="Writing order" style={{ display: "flex", alignItems: "flex-start", gap: 4, margin: "0 2px 9px", minHeight: 32, minWidth: 0 }}>
          {writingVariants.filter((variant) => variant.id === "main").map(renderVariantTab)}
          <div className="navigator-draft-tabs-scroll" style={{ flex: "1 1 0", minWidth: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "thin", scrollbarColor: "var(--scrollbar-thumb, #b8bec8) transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3, width: "max-content", minWidth: "100%", minHeight: 30 }}>
              {writingVariants.filter((variant) => variant.id !== "main").map(renderVariantTab)}
            </div>
          </div>
          <button type="button" title="Create draft order" aria-label="Create draft order" onClick={onAddWritingVariant}
            style={{ flex: "0 0 24px", width: 24, height: 26, border: "1px solid transparent", borderRadius: 4, background: "transparent", color: "var(--text-muted)", font: "inherit", fontSize: 17, lineHeight: "20px", cursor: "pointer" }}>+</button>
        </div>
        <style>{`.navigator-order-tab:focus-visible { outline: none !important; } .navigator-draft-tabs-scroll::-webkit-scrollbar { height: 5px; } .navigator-draft-tabs-scroll::-webkit-scrollbar-track { background: transparent; } .navigator-draft-tabs-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb, #b8bec8); border-radius: 5px; }`}</style>
        {variantMenu && <>
          <div aria-hidden="true" onClick={() => setVariantMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 40, background: "transparent" }} />
          <div role="menu" style={{ position: "fixed", zIndex: 41, left: variantMenu.x, top: variantMenu.y, minWidth: 138, padding: 4, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 5px 16px rgba(0,0,0,.16)" }}>
            <button role="menuitem" onClick={() => {
              const variant = writingVariants.find((item) => item.id === variantMenu.id);
              if (variant) { setEditingVariantId(variant.id); setEditingVariantName(variant.name); }
              setVariantMenu(null);
            }} style={{ display: "block", width: "100%", padding: "7px 9px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-1)", textAlign: "left", font: "inherit", fontSize: 12, cursor: "pointer" }}>Rename</button>
            <button role="menuitem" disabled={variantMenu.id === "main"} onClick={() => {
              const variant = writingVariants.find((item) => item.id === variantMenu.id);
              if (variant && variant.id !== "main") setPendingDelete({ type: "draft", id: variant.id, name: variant.name });
              setVariantMenu(null);
            }}
              style={{ display: "block", width: "100%", padding: "7px 9px", border: 0, borderRadius: 5, background: "transparent", color: variantMenu.id === "main" ? "var(--text-muted)" : "var(--text-1)", opacity: variantMenu.id === "main" ? .45 : 1, textAlign: "left", font: "inherit", fontSize: 12, cursor: variantMenu.id === "main" ? "default" : "pointer" }}>Delete</button>
          </div>
        </>}
        {pendingDelete && createPortal(
          <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingDelete(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 20000, display: "grid", placeItems: "center", padding: 20, background: "rgba(0,0,0,.34)" }}>
            <section role="alertdialog" aria-modal="true" aria-labelledby="navigator-delete-title"
              style={{ width: "min(360px, calc(100vw - 40px))", boxSizing: "border-box", padding: 18, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg)", color: "var(--text-1)", boxShadow: "0 12px 32px rgba(0,0,0,.28)" }}>
              <div id="navigator-delete-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Confirm deletion</div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-2)", marginBottom: 18 }}>
                {pendingDelete.type === "draft"
                  ? `Are you sure you want to delete “${pendingDelete.name}”?`
                  : `Are you sure you want to delete “${pendingDelete.name}”? This cannot be undone.`}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={() => setPendingDelete(null)} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--btn-bg)", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                <button type="button" onClick={() => {
                  if (pendingDelete.type === "draft") onDeleteWritingVariant(pendingDelete.id);
                  else onDeleteBoard(pendingDelete.id, pendingDelete.group);
                  setPendingDelete(null);
                }} style={{ padding: "6px 12px", border: "1px solid color-mix(in srgb, #e35d5d 55%, transparent)", borderRadius: 5, background: "color-mix(in srgb, #e35d5d 16%, transparent)", color: "var(--text-1)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Confirm</button>
              </div>
            </section>
          </div>, document.body
        )}
        <NavigatorSection title="Writing" group="writing" items={writing} activeId={activeId} selectedIds={selectedIds} onSelectBoard={onSelectBoard} getBoardLabel={getBoardLabel} onRenameBoard={onRenameBoard} onRenameGroup={onRenameGroup} onRequestDeleteBoard={(id, name, group) => setPendingDelete({ type: "board", id, name, group })} onGroupSelected={onGroupSelected} onUngroupSelected={onUngroupSelected} onToggleGroup={onToggleGroup} onMoveBoard={onMoveBoard} onSelectionChange={onSelectionChange} accentColor={accentColor} onAdd={() => onAddBoard("writing")} onOpenInMain={onOpenInMain} onOpenContextMenu={() => setContextMenuOwner("writing")} isContextMenuOwner={contextMenuOwner === "writing"} />
        <NavigatorSection title="Notes" group="notes" items={notes} activeId={activeId} selectedIds={selectedIds} onSelectBoard={onSelectBoard} getBoardLabel={getBoardLabel} onRenameBoard={onRenameBoard} onRenameGroup={onRenameGroup} onRequestDeleteBoard={(id, name, group) => setPendingDelete({ type: "board", id, name, group })} onGroupSelected={onGroupSelected} onUngroupSelected={onUngroupSelected} onToggleGroup={onToggleGroup} onMoveBoard={onMoveBoard} onSelectionChange={onSelectionChange} accentColor={accentColor} onAdd={() => onAddBoard("notes")} onOpenInMain={onOpenInMain} onOpenContextMenu={() => setContextMenuOwner("notes")} isContextMenuOwner={contextMenuOwner === "notes"} />
      </div>
    </section>
  );
}

function NavigatorSection({
  title,
  group,
  items,
  activeId,
  selectedIds,
  onSelectBoard,
  getBoardLabel,
  onRenameBoard,
  onRenameGroup,
  onRequestDeleteBoard,
  onGroupSelected,
  onUngroupSelected,
  onSelectionChange,
  onToggleGroup,
  onMoveBoard,
  accentColor,
  onAdd,
  onOpenInMain,
  onOpenContextMenu,
  isContextMenuOwner,
}: {
  title: string;
  group: BoardGroup;
  items: NavigatorTextItem[];
  activeId: string | null;
  selectedIds: string[];
  onSelectBoard: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  getBoardLabel?: (id: string) => string;
  onRenameBoard: (id: string, name: string) => void;
  onRenameGroup: (id: string, group: BoardGroup, name: string) => void;
  onRequestDeleteBoard: (id: string, name: string, group: BoardGroup) => void;
  onGroupSelected: (ids: string[], group: BoardGroup) => string | null;
  onUngroupSelected: (ids: string[], group: BoardGroup) => string[];
  onSelectionChange: (ids: string[]) => void;
  onToggleGroup: (id: string, group: BoardGroup) => void;
  onMoveBoard: Props["onMoveBoard"];
  accentColor?: string;
  onAdd: () => void;
  onOpenInMain: Props["onOpenInMain"];
  onOpenContextMenu: () => void;
  isContextMenuOwner: boolean;
}) {
  const [draggingBoardId, setDraggingBoardId] = React.useState<string | null>(null);
  const [editingBoardId, setEditingBoardId] = React.useState<string | null>(null);
  const [editingIsGroup, setEditingIsGroup] = React.useState(false);
  const [editingName, setEditingName] = React.useState("");
  const [contextMenu, setContextMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);
  const [dropMarkerY, setDropMarkerY] = React.useState<number | null>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (!contextMenu) return;
    const rect = contextMenuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(
      contextMenu.x + rect.width > window.innerWidth - margin ? contextMenu.x - rect.width : contextMenu.x,
      window.innerWidth - rect.width - margin,
    ));
    const top = Math.max(margin, Math.min(
      contextMenu.y + rect.height > window.innerHeight - margin ? contextMenu.y - rect.height : contextMenu.y,
      window.innerHeight - rect.height - margin,
    ));
    setContextMenuPosition({ id: contextMenu.id, x: left, y: top });
  }, [contextMenu]);
  React.useEffect(() => {
    if (!isContextMenuOwner || !contextMenu) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) return;
      setContextMenu(null);
      setContextMenuPosition(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(null);
      setContextMenuPosition(null);
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [contextMenu, isContextMenuOwner]);
  const visibleItems = items.flatMap((item) => item.kind === "group"
    ? [item, ...(item.collapsed ? [] : (item.children || []).map((child) => ({ ...child, parentGroupId: item.id })))]
    : [item]);
  const findEntry = (entryId: string): NavigatorTextItem | undefined => {
    for (const item of items) {
      if (item.id === entryId) return item;
      const child = item.children?.find((candidate) => candidate.id === entryId);
      if (child) return child;
    }
    return undefined;
  };

  const beginRename = (item: NavigatorTextItem) => {
    setEditingBoardId(item.id);
    setEditingIsGroup(item.kind === "group");
    setEditingName(item.kind === "group" ? item.label : getBoardLabel?.(item.id) || item.label);
    setContextMenu(null);
  };

  const finishRename = (save: boolean) => {
    if (save && editingBoardId) {
      if (editingIsGroup) onRenameGroup(editingBoardId, group, editingName.trim());
      else onRenameBoard(editingBoardId, editingName.trim());
    }
    setEditingBoardId(null);
  };

  return (
    <section
      ref={sectionRef}
      style={{ position: "relative", marginBottom: 14, minHeight: 42 }}
      aria-label={title}
      onDragOver={(event) => {
        if (!hasActiveNavigatorBoardDrag()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        const target = event.target as Element;
        if (target.closest("[data-navigator-item-id]")) return;
        const payload = readNavigatorBoardDrag(event.dataTransfer);
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        onMoveBoard({ boardId: payload.boardId, sourceGroup: payload.group, targetGroup: group, targetId: null, targetParentGroupId: null, position: "after" });
        setDropMarkerY(null);
      }}
    >
      <div
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          borderRadius: 4,
          color: "var(--text-1)",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {title}
        <NavigatorIconButton
          title={`Add ${title} board`}
          onClick={onAdd}
          icon={<span style={{ fontSize: 19, fontWeight: 300, lineHeight: 1, transform: "translateY(-1px)" }}>+</span>}
        />
      </div>
      {items.length === 0 ? (
        <div
          style={{
            minHeight: 36,
            padding: "8px",
            color: "var(--text-muted)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          No boards yet
        </div>
      ) : (
        <div
          ref={listRef}
          role="list"
          style={{ position: "relative", display: "grid", gap: 2 }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarkerY(null);
          }}
        >
          {visibleItems.map((item) => {
            const active = item.id === activeId;
            const selected = selectedIds.includes(item.id);
            const isGroup = item.kind === "group";
            const label = isGroup ? item.label : getBoardLabel?.(item.id) || item.label;
            const accent = accentColor || "var(--accent)";
            return (
              <div
                key={item.id}
                className="sw-navigator-item"
                data-navigator-item-id={item.id}
                role="listitem"
                tabIndex={0}
                aria-current={active ? "true" : undefined}
                aria-selected={selected}
                title={label}
                draggable={!isGroup}
                onClick={(event) => onSelectBoard(item.id, event)}
                onDragOver={(event) => {
                  if (!hasActiveNavigatorBoardDrag()) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const listBounds = listRef.current?.getBoundingClientRect();
                  const before = event.clientY < bounds.top + bounds.height / 2;
                  if (listBounds) {
                    const rowIndex = visibleItems.findIndex((visibleItem) => visibleItem.id === item.id);
                    const markerY = before
                      ? bounds.top - (rowIndex > 0 ? 1 : 0)
                      : bounds.bottom + (rowIndex < visibleItems.length - 1 ? 1 : 0);
                    setDropMarkerY(markerY - listBounds.top);
                  }
                }}
                onDrop={(event) => {
                  const payload = readNavigatorBoardDrag(event.dataTransfer);
                  if (!payload) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onMoveBoard({
                    boardId: payload.boardId,
                    sourceGroup: payload.group,
                    targetGroup: group,
                    targetId: item.id,
                    targetParentGroupId: item.parentGroupId ?? null,
                    position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                  });
                  setDropMarkerY(null);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  beginRename(item);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!selectedIds.includes(item.id)) onSelectBoard(item.id, event);
                  onOpenContextMenu();
                  setContextMenuPosition(null);
                  setContextMenu({
                    id: item.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onDragStart={(event) => {
                  if (isGroup) { event.preventDefault(); return; }
                  setDraggingBoardId(item.id);
                  beginNavigatorBoardDrag(event.dataTransfer, { boardId: item.id, group: item.group });
                  event.currentTarget.style.opacity = ".55";
                }}
                onDragEnd={(event) => {
                  event.currentTarget.style.opacity = "1";
                  setDraggingBoardId(null);
                  endNavigatorBoardDrag();
                }}
                style={{
                  minHeight: 30,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: `0 7px 0 ${item.parentGroupId ? 20 : 7}px`,
                  border: selected ? `1px solid color-mix(in srgb, ${accent} 28%, transparent)` : "1px solid transparent",
                  borderLeft: `2px solid ${selected ? `color-mix(in srgb, ${accent} 38%, transparent)` : "transparent"}`,
                  borderRadius: 3,
                  background: selected
                    ? `color-mix(in srgb, ${accent} 8%, var(--bg))`
                    : active ? `color-mix(in srgb, ${accent} 5%, transparent)` : "transparent",
                  color: active || selected ? "var(--text-1)" : "var(--text-muted)",
                  fontSize: 11,
                  lineHeight: 1.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  userSelect: "none",
                  touchAction: "none",
                  outline: "none",
                  opacity: draggingBoardId === item.id ? 0.55 : 1,
                  cursor: isGroup ? "default" : draggingBoardId === item.id ? "grabbing" : "grab",
                }}
              >
                {isGroup && (
                  <button
                    type="button"
                    aria-label={item.collapsed ? "Expand group" : "Collapse group"}
                    title={item.collapsed ? "Expand group" : "Collapse group"}
                    onClick={(event) => { event.stopPropagation(); onToggleGroup(item.id, group); }}
                    style={{
                      width: 20, height: 22, flex: "0 0 20px", padding: 0,
                      border: 0, background: "transparent", color: "var(--text-muted)",
                      cursor: "pointer", fontSize: 16, lineHeight: 1,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      {item.collapsed
                        ? <path d="m6 3.5 5 4.5-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        : <path d="m3.5 6 4.5 5 4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
                    </svg>
                  </button>
                )}
                {editingBoardId === item.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    aria-label="Board name"
                    onChange={(event) => setEditingName(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => finishRename(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); finishRename(true); }
                      if (event.key === "Escape") { event.preventDefault(); finishRename(false); }
                    }}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: "100%", minWidth: 0, border: 0, outline: 0,
                      padding: 0, background: "transparent", color: "inherit",
                      font: "inherit",
                    }}
                  />
                ) : (
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {label}
                  </span>
                )}
                {active && (
                  <span
                    aria-hidden="true"
                    title="Currently editing"
                    style={{
                      width: 14, height: 14, flex: "0 0 14px",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      color: `color-mix(in srgb, ${accent} 65%, transparent)`,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="m10.9 2.3 2.8 2.8M3 13l2.7-.6 7.6-7.6a1.2 1.2 0 0 0-1.7-1.7L4 10.7 3 13Z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </div>
            );
          })}
          {dropMarkerY !== null && hasActiveNavigatorBoardDrag() && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                zIndex: 3,
                pointerEvents: "none",
                left: 1,
                right: 1,
                top: dropMarkerY - 1,
                height: 2,
                borderRadius: 2,
                background: `color-mix(in srgb, ${accentColor || "var(--accent)"} 48%, transparent)`,
              }}
            />
          )}
        </div>
      )}
      {isContextMenuOwner && contextMenu && findEntry(contextMenu.id) && createPortal((
        <div
          ref={contextMenuRef}
          style={{
            position: "fixed",
            left: contextMenuPosition?.id === contextMenu.id ? contextMenuPosition.x : contextMenu.x,
            top: contextMenuPosition?.id === contextMenu.id ? contextMenuPosition.y : contextMenu.y,
            visibility: contextMenuPosition?.id === contextMenu.id ? "visible" : "hidden",
            zIndex: 10000, minWidth: 112, maxWidth: "calc(100vw - 16px)", padding: 4,
            border: "1px solid var(--border)", borderRadius: 5,
            background: "var(--bg)", boxShadow: "0 5px 16px rgba(0,0,0,.18)",
          }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        >
          {findEntry(contextMenu.id)?.kind !== "group" && (
            <button
              type="button"
              disabled={findEntry(contextMenu.id)?.isMain}
              onClick={() => {
                const item = findEntry(contextMenu.id);
                setContextMenu(null);
                if (item) onOpenInMain(item.id, item.group);
              }}
              style={{ ...contextMenuItemStyle, opacity: findEntry(contextMenu.id)?.isMain ? 0.5 : 1 }}
            >{findEntry(contextMenu.id)?.isMain ? "✓ Anchor Board" : "Open in Anchor Pane"}</button>
          )}
          <button
            type="button"
            onClick={() => {
              const item = findEntry(contextMenu.id);
              if (item) beginRename(item);
            }}
            style={{
              width: "100%", border: 0, borderRadius: 3, padding: "6px 8px",
              background: "transparent", color: "var(--text-1)", textAlign: "left",
              font: "inherit", fontSize: 11, cursor: "pointer",
            }}
          >Rename</button>
          {findEntry(contextMenu.id)?.kind === "group" ? (
            <button
              type="button"
              onClick={() => {
                const expanded = onUngroupSelected([contextMenu.id], group);
                setContextMenu(null);
                if (expanded[0]) requestAnimationFrame(() => {
                  sectionRef.current?.querySelector<HTMLElement>(`[data-navigator-item-id="${expanded[0]}"]`)?.focus();
                  onSelectionChange(expanded);
                });
              }}
              style={contextMenuItemStyle}
            >Ungroup</button>
          ) : (
            <button
              type="button"
              disabled={!selectedIds.length || selectedIds.some((id) => !items.some((entry) => entry.kind !== "group" && entry.id === id))}
              onClick={() => {
                const groupId = onGroupSelected(selectedIds, group);
                setContextMenu(null);
                if (groupId) requestAnimationFrame(() => {
                  sectionRef.current?.querySelector<HTMLElement>(`[data-navigator-item-id="${groupId}"]`)?.focus();
                  onSelectionChange([groupId]);
                });
              }}
              style={{ ...contextMenuItemStyle, opacity: selectedIds.length && selectedIds.every((id) => items.some((entry) => entry.kind !== "group" && entry.id === id)) ? 1 : 0.45 }}
            >Group</button>
          )}
          {findEntry(contextMenu.id)?.kind !== "group" && <button
            type="button"
            onClick={() => {
              const item = findEntry(contextMenu.id);
              if (item) onRequestDeleteBoard(item.id, getBoardLabel?.(item.id) || item.label, item.group);
              setContextMenu(null);
            }}
            style={{ ...contextMenuItemStyle, marginTop: 3, borderTop: "1px solid var(--border)", borderRadius: 0, paddingTop: 8 }}
          >Delete Board</button>}
        </div>
      ), document.body)}
    </section>
  );
}

const contextMenuItemStyle: React.CSSProperties = {
  width: "100%", border: 0, borderRadius: 3, padding: "6px 8px",
  background: "transparent", color: "var(--text-1)", textAlign: "left",
  font: "inherit", fontSize: 11, cursor: "pointer",
};

function NavigatorIconButton({
  title,
  onClick,
  icon,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 22,
        height: 22,
        flex: "0 0 22px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "1px solid transparent",
        borderRadius: 4,
        background: hovered ? "var(--hover)" : "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
      }}
    >
      {icon}
    </button>
  );
}
