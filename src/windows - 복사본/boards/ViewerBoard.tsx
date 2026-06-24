// src/windows/boards/ViewerBoard.tsx
import React, {
  forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";

export type ViewerBoardHandle = {
  getSelected: () => { id: string; html: string } | null;
};

type TextItem = { id: string; html: string; preview: string };

export type ViewerState = {
  fileLabel: string;
  boards: TextItem[];
  selectedId: string;
  q: string;
};
type Props = {
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
};

const HANDLE_H = 30; 
const HANDLE_W = 28;   
const PAD_PCT  = 2.5; 

function firstLineFromHTML(html: string, max = 80) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const raw = (div.textContent || "").replace(/\u00A0/g, " ").trim();
  const line = raw.split(/\r?\n/)[0] || "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

async function openSwonFile(): Promise<{
  fileLabel: string;
  boards: TextItem[];
} | null> {
  try {
    if (!(window as any).__TAURI_IPC__) {
      window.dispatchEvent(
        new CustomEvent("sw:status", {
          detail: { text: "You can open .swon files only in the desktop app.", level: "warn" },
        })
      );
      return null;
    }
    const { open } = await import("@tauri-apps/api/dialog");
    const { readTextFile } = await import("@tauri-apps/api/fs");
    const { basename } = await import("@tauri-apps/api/path");

    const picked = await open({
      multiple: false,
      filters: [{ name: "Splitwriter", extensions: ["swon"] }],
    });
    if (!picked || Array.isArray(picked)) return null;

    const text = await readTextFile(picked as string);
    const data = JSON.parse(text || "{}");

    const map: Record<string, string> = {
      ...(data.openText || {}),
      ...(data.archivedText || {}),
      ...(data.text || {}),
    };

    const boards: TextItem[] = Object.entries(map).map(([id, html]) => ({
      id,
      html: html || "",
      preview: firstLineFromHTML(html || ""),
    }));

    const fileLabel = await basename(picked as string);
    return { fileLabel, boards };
  } catch (err) {
    console.error(err);
    window.dispatchEvent(
      new CustomEvent("sw:status", { detail: { text: "Couldn't open the file." } })
    );
    return null;
  }
}

const ViewerBoard = forwardRef<ViewerBoardHandle, Props>(function ViewerBoard({ state, onChange }, ref) {
  const { fileLabel, boards, selectedId, q } = state;

  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => ({
    getSelected() {
      const b = boards.find((x) => x.id === selectedId);
      return b ? { id: b.id, html: b.html } : null;
    },
  }));

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!listRef.current) return;
      if (!listRef.current.contains(e.target as any)) setListOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return boards;
    return boards.filter(
      (b) =>
        b.id.toLowerCase().includes(s) ||
        (b.preview || "").toLowerCase().includes(s)
    );
  }, [boards, q]);

  const selected = useMemo(
    () => boards.find((b) => b.id === selectedId) || null,
    [boards, selectedId]
  );

  const handleOpenSwon = async () => {
    const res = await openSwonFile();
    if (!res) return;

    onChange({
      fileLabel: res.fileLabel,
      boards: res.boards,
      selectedId: res.boards[0]?.id || "",
      q: "", 
    });

    window.dispatchEvent(
      new CustomEvent("sw:status", {
        detail: { text: `${res.fileLabel} — ${res.boards.length} boards loaded` },
      })
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        gridTemplateRows: `${HANDLE_H}px 1fr`,
        gridTemplateColumns: `${HANDLE_W}px 1fr`,
        color: "var(--text-1)",
        background: "var(--bg)",
      }}
    >
      {/* --- 상단 바 --- */}
      <div
        style={{
          gridRow: "1 / 2",
          gridColumn: "2 / 3",
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "center",
          gap: 8,
          height: HANDLE_H,
          paddingInline: `${PAD_PCT}%`,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: 8,
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 12,
              opacity: 0.75,
              whiteSpace: "nowrap",
              color: "var(--text-2)",
            }}
            title={fileLabel || "No file"}
          >
            {fileLabel ? `${fileLabel} —` : "No file —"}
          </div>

          {/* 검색 + 드롭다운 */}
          <div style={{ position: "relative", minWidth: 0 }} ref={listRef}>
            <input
              value={q}
              onChange={(e) => {
                onChange({ q: e.target.value });
                setListOpen(true);
              }}
              onFocus={() => setListOpen(true)}
              placeholder="Search boards…"
              style={{
                width: "100%",
                height: HANDLE_H,
                lineHeight: `${HANDLE_H}px`,
                padding: "0 10px",
                borderRadius: 8,
                border: "1px solid var(--input-border)",
                background: "var(--input-bg)",
                color: "var(--text-1)",
                outline: "none",
                fontSize: 12,
              }}
            />
            {listOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "calc(100% + 6px)",
                  maxHeight: 260,
                  overflow: "auto",
                  background: "var(--panel-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  zIndex: 5,
                }}
              >
                {filtered.length === 0 ? (
                  <div
                    style={{
                      padding: 10,
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    No results.
                  </div>
                ) : (
                  filtered.map((b) => (
                    <div
                      key={b.id}
                      onMouseDown={() => {
                        onChange({ selectedId: b.id, q: "" });
                        setListOpen(false);
                      }}
                      className="viewer-dd-item"
                      style={{
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--divider)",
                        cursor: "pointer",
                        color: "var(--text-1)",
                      }}
                      title={b.preview}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {b.preview || "(Empty line)"}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          opacity: 0.7,
                          color: "var(--text-muted)",
                          marginTop: 2,
                        }}
                      >
                        {b.id}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Open 버튼 */}
        <button
          type="button"
          onClick={handleOpenSwon}
          style={{
            height: HANDLE_H,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--btn-bg)",
            color: "var(--text-1)",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Open SWON…
        </button>
      </div>

      {/* --- 본문 --- */}
      <div
        style={{
          gridRow: "2 / 3",
          gridColumn: "2 / 3",
          paddingLeft: `${PAD_PCT}%`,
          paddingRight: `calc(${PAD_PCT}% + ${HANDLE_W}px)`,
          paddingBlock: "12px",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <div
          style={{
            height: "100%",
            overflow: "auto",
            background: "var(--panel-bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "12px",
            scrollbarGutter: "stable both-edges" as any,
          }}
        >
          {selected ? (
            <div
              data-role="viewer-content"
              style={{ minHeight: "100%", color: "var(--text-1)" }}
              dangerouslySetInnerHTML={{ __html: selected.html || "" }}
            />
          ) : (
            <div
              style={{
                opacity: 0.7,
                fontSize: 12,
                padding: 12,
                color: "var(--text-muted)",
              }}
            >
              Open a .swon file and pick a text board from the dropdown.
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default ViewerBoard;
