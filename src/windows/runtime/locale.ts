// runtime/locale.ts
export type InputLocaleId =
  | "auto"
  | "en"
  | "ko"
  | "zh-hans"
  | "zh-hant"
  | "ja"
  | "ru"
  | "fr"
  | "de"
  | "ar";

export type InputLocaleOption = {
  id: InputLocaleId;
  label: string;  // 드롭다운 표시명 (자국어 표기 권장)
  lang?: string;  // html lang 에 넣을 BCP47 (auto면 undefined)
};

export const INPUT_LOCALES: InputLocaleOption[] = [
  { id: "auto", label: "System / Auto" },
  { id: "en", label: "English", lang: "en" },
  { id: "ko", label: "한국어", lang: "ko" },
  { id: "zh-hans", label: "中文（简体）", lang: "zh-Hans" },
  { id: "zh-hant", label: "中文（繁體）", lang: "zh-Hant" },
  { id: "ja", label: "日本語", lang: "ja" },
  { id: "ru", label: "Русский", lang: "ru" },
  { id: "fr", label: "Français", lang: "fr" },
  { id: "de", label: "Deutsch", lang: "de" },
  { id: "ar", label: "العربية", lang: "ar" },
];

export function normalizeInputLocaleId(v: any): InputLocaleId {
  const s = String(v || "auto");
  const ok = INPUT_LOCALES.some((x) => x.id === s);
  return (ok ? s : "auto") as InputLocaleId;
}

export function resolveInputLocale(id?: any): InputLocaleOption {
  const norm = normalizeInputLocaleId(id);
  return INPUT_LOCALES.find((x) => x.id === norm)!;
}
