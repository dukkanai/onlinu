import type { Locale } from "../types";
import { extensionEnglish, extensionArabic, type ExtensionDictionary } from "./extension-source";

// Both interface languages supply every operation label independently.
export const extensions: Record<Locale, ExtensionDictionary> = {
  ar: extensionArabic,
  en: extensionEnglish,
};

export { extensionEnglish, extensionArabic } from "./extension-source";
export type { ExtensionKey, ExtensionDictionary } from "./extension-source";
