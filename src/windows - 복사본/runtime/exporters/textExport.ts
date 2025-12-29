// src/windows/runtime/exporters/textExport.ts
function firstLine(s: string): string {
  const line = (s || "").split(/\r?\n/)[0] || "untitled";
  return line.trim();
}
function sanitize(s: string): string {
  const t = s.replace(/[\\\/:*?"<>|]+/g, " ").trim();
  return t ? t : "untitled";
}

/** 성공 시 파일명(베이스네임)을, 취소 시 null 반환 */
export async function exportPlainText(getPlain: () => string): Promise<string | null> {
  const plain = (getPlain?.() || "").replace(/\r\n/g, "\n");
  const base = sanitize(firstLine(plain)) + ".txt";

  const isTauri = Boolean((window as any).__TAURI_IPC__);
  if (isTauri) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/api/dialog"),
      import("@tauri-apps/api/fs"),
    ]);
    const dest = await save({ defaultPath: base, filters: [{ name: "TXT", extensions: ["txt"] }] });
    if (typeof dest === "string") {
      await writeTextFile(dest, plain);
      return dest.split(/[\/\\]/).pop() || base;
    }
    return null; // 취소
  }

  // Web
  const blob = new Blob([plain], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = base;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  return base;
}
