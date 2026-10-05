import type { Locale } from "../types";
import { completionEnglish, completionArabic, type CompletionDictionary } from "./completion-source";

// Each supported interface language has a complete dictionary.
export const completions: Record<Locale, CompletionDictionary> = {
  ar: completionArabic,
  en: completionEnglish,
};
export { completionEnglish, completionArabic } from "./completion-source";
export type { CompletionDictionary } from "./completion-source";
