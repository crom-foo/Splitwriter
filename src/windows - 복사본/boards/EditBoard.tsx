// src/board/EditBoard.tsx
import * as React from "react";

const CTL_FONT = 12;
const CTL_H = 28;

const ICONS = {
  Refresh: new URL("../icons/Refresh.png", import.meta.url).href,
};

const sx = {
  input: {
    width: "100%",
    height: CTL_H,
    lineHeight: `${CTL_H}px`,
    fontSize: CTL_FONT,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid var(--input-border)",
    background: "var(--input-bg)",
    color: "var(--text-1)",
    outline: "none",
  } as React.CSSProperties,

  btn: {
    height: CTL_H,
    lineHeight: `${CTL_H}px`,
    fontSize: CTL_FONT,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--btn-bg)",
    color: "var(--text-1)",
    cursor: "pointer",
    fontWeight: 600,
  } as React.CSSProperties,

  btnIcon: {
    width: CTL_H,
    height: CTL_H,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--btn-bg)",
    cursor: "pointer",
    padding: 0,
  } as React.CSSProperties,
};

type TextEntry = {
  id: string;
  html?: string;
  preview?: string;
  source?: "open" | "saved";
};
type Props = { onDeleteRequest: (ids: string[]) => void };

// Derive first line preview from HTML
function firstLineFromHTML(html: string, max = 80) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const raw = (div.textContent || "").replace(/\u00A0/g, " ").trim();
  const line = raw.split(/\r?\n/)[0] || "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// Icon-only button with hover highlight and tooltip
function IconButton({
  icon,
  title,
  onClick,
  disabled,
}: {
  icon: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = React.useState(false);
  const isDisabled = !!disabled;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={isDisabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...sx.btnIcon,
        cursor: isDisabled ? "default" : "pointer",
        background:
          hover && !isDisabled
            ? "color-mix(in srgb, var(--accent) 18%, var(--btn-bg) 82%)"
            : "var(--btn-bg)",
        border:
          hover && !isDisabled
            ? "1px solid color-mix(in srgb, var(--accent) 70%, var(--border) 30%)"
            : "1px solid var(--border)",
        opacity: isDisabled ? 0.6 : 1,
        transition: "background .12s, border-color .12s, opacity .12s",
      }}
    >
      <img
        src={icon}
        alt=""
        width={14}
        height={14}
        draggable={false}
        className="sw-icon"
        style={{ opacity: disabled ? 0.55 : 0.9 }}
      />
    </button>
  );
}

function resolveAccent(): string {
  if (typeof window === "undefined") return "var(--accent)";
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    return v || "var(--accent)";
  } catch {
    return "var(--accent)";
  }
}

export default function EditBoard({ onDeleteRequest }: Props) {
  const [texts, setTexts] = React.useState<TextEntry[]>([]);
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<Record<string, boolean>>({});
  const [isRefreshing, setRefreshing] = React.useState(false);
  const accent = React.useMemo(() => resolveAccent(), []);

  // Listen for edit state and seed list
  React.useEffect(() => {
    const onState = (e: Event) => {
      const { texts = [] } = (e as CustomEvent).detail || {};
      setTexts(
        (texts as TextEntry[]).map((t) => ({
          ...t,
          preview: t.preview ?? firstLineFromHTML(t.html || ""),
        }))
      );
      setSel({});
      setRefreshing(false);
    };
    window.addEventListener("sw:edit:state", onState as any, { capture: true });
    window.dispatchEvent(new CustomEvent("sw:edit:get"));
    return () =>
      window.removeEventListener("sw:edit:state", onState as any, {
        capture: true,
      });
  }, []);

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return texts;
    return texts.filter(
      (b) =>
        b.id.toLowerCase().includes(s) ||
        (b.preview || "").toLowerCase().includes(s)
    );
  }, [q, texts]);

  const anyChecked = Object.values(sel).some(Boolean);
  const toggleAll = (v: boolean) => {
    const next: Record<string, boolean> = {};
    for (const t of filtered) next[t.id] = v;
    setSel(next);
  };

  const sendDelete = (ids: string[]) => {
    if (!ids.length) return;
    onDeleteRequest(ids);
  };

  const deleteSelected = () => {
    const ids = Object.keys(sel).filter((k) => sel[k]);
    sendDelete(ids);
  };
  const deleteOne = (id: string) => sendDelete([id]);

  const refresh = React.useCallback(() => {
    if (isRefreshing) return;
    setRefreshing(true);
    window.dispatchEvent(new CustomEvent("sw:edit:get"));
  }, [isRefreshing]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        color: "var(--text-1)",
        paddingTop: 30,
        background: "var(--bg)",
        boxShadow: "inset 0 1px 0 var(--divider)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 10px 6px",
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) auto auto", // input grows; right buttons fixed
          gap: 8,
          alignItems: "center",
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search boards…"
          style={sx.input}
        />

        {/* Refresh (icon-only) */}
        <IconButton
          icon={ICONS.Refresh}
          title="Refresh"
          onClick={refresh}
          disabled={isRefreshing}
        />

        {/* Delete selected */}
        <button
          type="button"
          onClick={deleteSelected}
          disabled={!anyChecked}
          style={{
            ...sx.btn,
            background: anyChecked ? accent : "var(--btn-bg)",
            color: anyChecked ? "#f9fafb" : "var(--text-1)",
            border: anyChecked ? `1px solid ${accent}` : "1px solid var(--border)",
            boxShadow: anyChecked ? `0 0 0 1px ${accent}` : "none",
            cursor: anyChecked ? "pointer" : "default",
          }}
        >
          Delete selected
        </button>
      </div>

      {/* List */}
      <div style={{ overflow: "auto", padding: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >{`Text boards (${filtered.length})`}</div>
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
            }}
          >
            <SmallButton onClick={() => toggleAll(true)}>Select all</SmallButton>
            <SmallButton onClick={() => toggleAll(false)}>Clear</SmallButton>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyRow label="No text boards" />
        ) : (
          filtered.map((t) => (
            <Row key={t.id}>
              <input
                type="checkbox"
                checked={!!sel[t.id]}
                onChange={(e) => setSel({ ...sel, [t.id]: e.target.checked })}
                style={{ marginRight: 10, accentColor: accent }}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--text-1)",
                  }}
                  title={t.preview}
                >
                  {t.preview || "(Empty line)"}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    opacity: 0.8,
                    marginTop: 2,
                    color: "var(--text-muted)",
                  }}
                >
                  {t.id}
                  {t.source ? ` • ${t.source}` : ""}
                </div>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <SmallButton onClick={() => deleteOne(t.id)}>delete</SmallButton>
              </div>
            </Row>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "10px 12px",
        border: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--panel-bg) 88%, transparent)",
        borderRadius: 8,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: 12,
        opacity: 0.85,
        fontSize: 12,
        border: "1px dashed var(--border)",
        borderRadius: 8,
        marginBottom: 8,
        color: "var(--text-muted)",
        background: "color-mix(in srgb, var(--panel-bg) 92%, transparent)",
      }}
    >
      {label}
    </div>
  );
}

function SmallButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        lineHeight: "26px",
        fontSize: 12,
        padding: "0 10px",
        borderRadius: 6,
        background: "var(--btn-bg)",
        border: "1px solid var(--border)",
        color: "var(--text-1)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
