// src/shared/presets.ts
import { readTextFile, writeTextFile, createDir, exists } from "@tauri-apps/api/fs";
import { invoke } from "@tauri-apps/api/tauri";
import { appConfigDir, executableDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { open as openInOS } from "@tauri-apps/api/shell";
import { DEFAULT_PREFS, type SplitwriterPrefs } from "./defaultPrefs";

async function isPortable() {
  try {
    const ex = await executableDir();
    const flag = await join(ex, "portable.flag"); // ← 파일이 있으면 포터블 모드
    return await exists(flag);
  } catch {
    return false;
  }
}

async function presetRootDir() {
  const base = (await isPortable()) ? await executableDir() : await appConfigDir();
  const dir = await join(base, "Splitwriter", "presets");
  try {
    await createDir(dir, { recursive: true });
  } catch {}
  return dir;
}

// OS 파일탐색기에서 프리셋 폴더 열기
export async function revealPresetFolder(): Promise<void> {
  const dir = await presetRootDir();
  await invoke("reveal_preset_folder", { path: dir });
}

// 프리셋 저장 (Theme 포함)
export async function savePreset(name: string, prefs: SplitwriterPrefs) {
  const dir = await presetRootDir();
  const file = await join(dir, `${name}.swpreset.json`);
  const data = {
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    ...prefs,
  };
  await writeTextFile(file, JSON.stringify(data, null, 2));

  // 인덱스 업데이트
  const idx = await join(dir, "index.json");
  let items: string[] = [];
  try {
    items = JSON.parse(await readTextFile(idx)).items || [];
  } catch {}
  items = [name, ...items.filter((n) => n !== name)].slice(0, 20);
  await writeTextFile(idx, JSON.stringify({ active: name, items }, null, 2));
}

// 저장된 프리셋 목록
export async function listPresets(): Promise<string[]> {
  const dir = await presetRootDir();
  const idxPath = await join(dir, "index.json");

  try {
    const idxRaw = await readTextFile(idxPath);
    const idx = JSON.parse(idxRaw) as { active?: string; items?: string[] };

    const rawItems: string[] = Array.isArray(idx.items) ? idx.items : [];
    const valid: string[] = [];

    // 실제 파일이 있는 프리셋만 남기기
    for (const name of rawItems) {
      if (!name) continue;
      const file = await join(dir, `${name}.swpreset.json`);
      try {
        if (await exists(file)) {
          valid.push(name);
        }
      } catch {
        // exists 에러면 그냥 무시하고 해당 항목은 버린다
      }
    }

    // index.json 안에 쓰레기가 있으면 같이 정리
    if (valid.length !== rawItems.length) {
      const activeName = typeof idx.active === "string" ? idx.active : null;
      const active = activeName && valid.includes(activeName) ? activeName : (valid[0] ?? null);

      try {
        await writeTextFile(
          idxPath,
          JSON.stringify({ active, items: valid }, null, 2)
        );
      } catch {
        // 정리 실패해도 동작에는 지장 없음
      }
    }

    return valid;
  } catch {
    // index.json 이 없거나 깨졌으면 그냥 빈 리스트
    return [];
  }
}

// 프리셋 로드
export async function loadPreset(name: string): Promise<SplitwriterPrefs | null> {
  const dir = await presetRootDir();
  const file = await join(dir, `${name}.swpreset.json`);
  try {
    const raw = JSON.parse(await readTextFile(file)) as any;

    // metadata(version/name/createdAt)는 버리고, 실제 prefs 서브셋만 뽑는다
    const picked: SplitwriterPrefs = {
      workingFolder: typeof raw.workingFolder === "string" ? raw.workingFolder : "",
      autosave: typeof raw.autosave === "boolean" ? raw.autosave : DEFAULT_PREFS.autosave,
      autosaveIntervalSec:
        typeof raw.autosaveIntervalSec === "number" ? raw.autosaveIntervalSec : DEFAULT_PREFS.autosaveIntervalSec,
      typeface: raw.typeface ?? DEFAULT_PREFS.typeface,
      accentColor: typeof raw.accentColor === "string" ? raw.accentColor : DEFAULT_PREFS.accentColor,
      writingGoal: raw.writingGoal ?? DEFAULT_PREFS.writingGoal,
      bracket: raw.bracket ?? DEFAULT_PREFS.bracket,
      theme: raw.theme === "light" ? "light" : "dark",
      // inputLocale는 SplitwriterPrefs에 넣으면 여기까지 포함
      ...(typeof raw.inputLocale === "string"
        ? ({ inputLocale: raw.inputLocale } as any)
        : ({} as any)),
    };

    return picked;
  } catch {
    return null;
  }
}

// "Default preset" 버튼에서 사용하는 공장 초기값
export async function applyDefault(): Promise<SplitwriterPrefs> {
  return {
    workingFolder: "",
    autosave: DEFAULT_PREFS.autosave,
    autosaveIntervalSec: DEFAULT_PREFS.autosaveIntervalSec,
    typeface: DEFAULT_PREFS.typeface,
    accentColor: DEFAULT_PREFS.accentColor,
    writingGoal: DEFAULT_PREFS.writingGoal,
    bracket: DEFAULT_PREFS.bracket,
    theme: DEFAULT_PREFS.theme,
    inputLocale: (DEFAULT_PREFS as any).inputLocale ?? "auto",
  } as any;
}
