import type { Locale } from "../types";
import { english as baseEnglish } from "./en";
import type { Dictionary as BaseDictionary } from "./en";
import { extensions, extensionEnglish, type ExtensionDictionary } from "./extension";
import { completions, completionEnglish, type CompletionDictionary } from "./completion";
import { ar } from "./ar";
import { iterationThemeEnglish } from "./iteration-theme-source";
import { iterationThemes } from "./iteration-theme";
import { deliveryReopen, deliveryReopenEnglish } from "./iteration-delivery";

export const iterationEnglish = { ...iterationThemeEnglish, ...deliveryReopenEnglish } as const;
export type IterationDictionary = Record<keyof typeof iterationEnglish, string>;
export const iterations: Record<Locale, IterationDictionary> = {
  ar: { ...iterationThemes.ar, ...deliveryReopen.ar },
  en: iterationEnglish,
};

export const english = { ...baseEnglish, ...extensionEnglish, ...completionEnglish, ...iterationEnglish } as const;
export type Dictionary = BaseDictionary & ExtensionDictionary & CompletionDictionary & IterationDictionary;
export type TranslationKey = keyof Dictionary;

export const dictionaries: Record<Locale, Dictionary> = {
  ar: { ...ar, ...extensions.ar, ...completions.ar, ...iterations.ar },
  en: english,
};
