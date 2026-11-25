import { t } from "nsh/i18n";

export type Language = "zh" | "en";

/** Keep explicit window language while NSH owns translation lookup and fallback. */
export function tr(language: Language, key: __MESSAGE_KEYS__): string {
  return t(key, { locale: language });
}
