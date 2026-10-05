import type { Locale } from "../types";
import { iterationThemeEnglish, iterationThemeArabic } from "./iteration-theme-source";

type ThemeDictionary = Record<keyof typeof iterationThemeEnglish, string>;
export const iterationThemes: Record<Locale, ThemeDictionary> = {
  en: iterationThemeEnglish,
  ar: iterationThemeArabic,
};
