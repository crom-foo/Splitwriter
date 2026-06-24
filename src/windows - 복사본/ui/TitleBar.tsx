// src/windows/ui/TitleBar.tsx
/**
 * Splitwriter 커스텀 타이틀바.
 *
 * - 좌측: 앱 이름 + 현재 파일명
 * - 우측: 최소화 / 전체화면 / 닫기(quitWithGuard)
 *
 * 파일명은 window.__SW_CURRENT_FILE__ 와
 *   sw:file:opened / sw:file:label / sw:file:cleared
 *   sw:opened(Tauri 이벤트)
 * 를 전부 듣고 동기화한다.
 */

import React from "react";
import { appWindow } from "@tauri-apps/api/window";
import { quitWithGuard } from "../runtime/appActions";

declare global {
  interface Window {
    __SW_CURRENT_FILE__?: string;
  }
}

function baseName(p?: string | null): string {
  if (!p) return "";
  const seg = String(p).split(/[\\/]/).pop();
  return seg || "";
}

export default function TitleBar() {
  const [fileLabel, setFileLabel] = React.useState("");

  const isTauri =
    typeof window !== "undefined" &&
    (("__TAURI_IPC__" in window) || (window as any).__TAURI__);

  React.useEffect(() => {
    let unsubTauri: (() => void) | null = null;
    let pollTimer: number | null = null;

    const readGlobal = (): string => {
      try {
        return (window as any).__SW_CURRENT_FILE__ || "";
      } catch {
        return "";
      }
    };

    const apply = (p?: string | null) => {
      const name = baseName(p);
      // 그냥 매번 덮어쓴다. (첫 이름만 고정되는 버그 제거)
      setFileLabel(name);
      try {
        document.title = name ? `${name} — Splitwriter` : "Splitwriter";
      } catch {
        /* ignore */
      }
    };

    // 초기 1회 동기화
    apply(readGlobal());

    const onOpened = (ev: any) => {
      const detail = ev?.detail || {};
      apply(detail.path ?? detail.name ?? readGlobal());
    };
    const onLabel = (ev: any) => {
      const detail = ev?.detail || {};
      apply(detail.path ?? detail.name ?? readGlobal());
    };
    const onCleared = () => apply("");

    window.addEventListener("sw:file:opened", onOpened as any);
    window.addEventListener("sw:file:label", onLabel as any);
    window.addEventListener("sw:file:cleared", onCleared as any);

    // Tauri 이벤트도 한 번 더 듣기
    (async () => {
      try {
        if ((window as any).__TAURI_IPC__) {
          const { listen } = await import("@tauri-apps/api/event");
          unsubTauri = await listen("sw:opened", (ev: any) => {
            const payload = (ev && (ev as any).payload) || {};
            const path = (payload as any).path;
            const title = (payload as any).title;
            apply(path ?? title ?? readGlobal());
          });
        }
      } catch {
        /* ignore */
      }
    })();

    // 폴백: 1초마다 전역값 폴링
    pollTimer = window.setInterval(() => {
      apply(readGlobal());
    }, 1000) as unknown as number;

    return () => {
      window.removeEventListener("sw:file:opened", onOpened as any);
      window.removeEventListener("sw:file:label", onLabel as any);
      window.removeEventListener("sw:file:cleared", onCleared as any);
      if (pollTimer != null) window.clearInterval(pollTimer);
      if (unsubTauri) {
        try {
          unsubTauri();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const minimize = () => {
    if (isTauri) appWindow.minimize();
  };

  const toggleFullscreen = async () => {
    if (!isTauri) return;
    const f = await appWindow.isFullscreen();
    await appWindow.setFullscreen(!f);
  };

  const closingRef = React.useRef(false);
  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      await quitWithGuard();
    } finally {
      closingRef.current = false;
    }
  };

  return (
    <div
      className="titlebar h-9 flex items-center justify-between px-2 select-none flex-shrink-0 border-b"
      style={{
        background: "var(--topbar)",
        borderColor: "var(--topbar-divider)",
      }}
    >
      <div
        className="flex-1 h-full flex items-center gap-2 text-xs pr-2"
        data-tauri-drag-region
        onDoubleClick={toggleFullscreen}
        style={{ color: "var(--text-2)" }}
      >
        <span className="uppercase tracking-widest">SPLITWRITER</span>
        {fileLabel ? <span className="opacity-60">· {fileLabel}</span> : null}
      </div>

      <div className="flex items-center gap-1">
        <button
          className="titlebar-btn w-9 h-6 grid place-items-center rounded focus:outline-none"
          title="Minimize"
          aria-label="Minimize window"
          onClick={minimize}
          disabled={!isTauri}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" className="opacity-80">
            <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          className="titlebar-btn w-9 h-6 grid place-items-center rounded focus:outline-none"
          title="Fullscreen"
          aria-label="Toggle fullscreen"
          onClick={toggleFullscreen}
          disabled={!isTauri}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" className="opacity-80">
            <path
              d="M2 5V2h3M7 2h3v3M10 7v3H7M5 10H2V7"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          className="titlebar-btn titlebar-btn--danger w-9 h-6 grid place-items-center rounded focus:outline-none"
          title="Close"
          aria-label="Close window"
          onClick={close}
          disabled={!isTauri}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" className="opacity-80">
            <path
              d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <style>{`
        .titlebar-btn {
          color: var(--icon);
          transition:
            background-color 120ms ease-out,
            color 120ms ease-out,
            box-shadow 120ms ease-out;
        }

        /* 일반 버튼(Min / Fullscreen) */
        .titlebar-btn:not(.titlebar-btn--danger):hover {
          background-color: var(--hover);      /* 토큰 기반, 라이트/다크 둘 다 보이게 */
          color: var(--icon-pressed);
        }

        /* 닫기 버튼(X) */
        .titlebar-btn--danger:hover {
          background-color: rgba(248, 113, 113, 0.22);
          color: #e0243b;
        }

        .titlebar-btn:disabled {
          opacity: 0.45;
          cursor: default;
        }

        .titlebar-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 1px var(--accent);
        }
      `}</style>
    </div>
  );
}
