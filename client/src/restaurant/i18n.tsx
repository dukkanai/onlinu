import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "./types";
import { dictionaries, type TranslationKey } from "./locales";

export const LOCALES = ["ar", "en"] as const satisfies readonly Locale[];
export const LANGUAGE_NAMES: Record<Locale, string> = {
  ar: "العربية", en: "English",
};
export const LOCALE_STORAGE_KEY = "restaurant.locale";
export type TranslationVariables = Record<string, string | number>;
export const isLocale = (value: unknown): value is Locale => typeof value === "string" && (LOCALES as readonly string[]).includes(value);
// Persisted browser preferences and responses from an older server may still
// contain a removed locale. Normalize at the boundary before using dictionaries.
export const normalizeLocale = (value: unknown): Locale => isLocale(value) ? value : "ar";
export const localeDirection = (locale: Locale): "rtl" | "ltr" => normalizeLocale(locale) === "ar" ? "rtl" : "ltr";

export function applyDocumentLocale(root: Pick<HTMLElement, "lang" | "dir">, locale: Locale): () => void {
  const previous = { lang: root.lang, dir: root.dir };
  root.lang = normalizeLocale(locale);
  root.dir = localeDirection(locale);
  return () => { root.lang = previous.lang; root.dir = previous.dir; };
}

// Values are inserted as plain React text, never HTML or a second template.
// Restaurant-entered names/descriptions never pass through this dictionary.
export function translate(locale: Locale, key: string, variables: TranslationVariables = {}): string {
  const dictionary = dictionaries[normalizeLocale(locale)];
  const template = Object.hasOwn(dictionary, key) ? dictionary[key as TranslationKey] : dictionary["common.error"];
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : placeholder,
  );
}

export function currencyMinorDigits(currency: string = "SAR"): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Invalid currency settings are rejected by the server. Throw here too so
    // an admin input never silently changes the numeric scale of an amount.
    throw new RangeError("Invalid currency code");
  }
}

export function formatMoney(locale: Locale, minor: number, currency: string = "SAR"): string {
  if (!Number.isSafeInteger(minor)) return "—";
  try {
    const digits = currencyMinorDigits(currency);
    return new Intl.NumberFormat(normalizeLocale(locale), { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
  } catch { return "—"; }
}

export function formatDate(locale: Locale, value: string | number | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(normalizeLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

export function readLocalePreference(fallback: unknown = "ar", storage?: Pick<Storage, "getItem">): { locale: Locale; explicitPreference: boolean } {
  const supportedDefault = normalizeLocale(fallback);
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const saved = target?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(saved) ? { locale: saved, explicitPreference: true } : { locale: supportedDefault, explicitPreference: false };
  } catch { return { locale: supportedDefault, explicitPreference: false }; }
}

export const initialLocale = (fallback: unknown = "ar", storage?: Pick<Storage, "getItem">): Locale => readLocalePreference(fallback, storage).locale;

export function localeWithDefault(preference: { locale: Locale; explicitPreference: boolean }, fallback: unknown) {
  return preference.explicitPreference && isLocale(preference.locale) ? preference : { locale: normalizeLocale(fallback), explicitPreference: false };
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  applyDefaultLocale: (locale: Locale) => void;
  t: (key: string, variables?: TranslationVariables) => string;
  money: (minor: number, currency?: string) => string;
  date: (value: string | number | Date) => string;
  dir: "rtl" | "ltr";
}
const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children, defaultLocale = "ar" }: { children: ReactNode; defaultLocale?: Locale }) {
  const [preference, updatePreference] = useState(() => readLocalePreference(defaultLocale));
  const locale = preference.locale;
  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    updatePreference({ locale: next, explicitPreference: true });
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Preference still applies for this visit. */ }
  }, []);
  const applyDefaultLocale = useCallback((next: Locale) => {
    updatePreference(previous => localeWithDefault(previous, next));
  }, []);
  useEffect(() => { applyDefaultLocale(defaultLocale); }, [defaultLocale, applyDefaultLocale]);
  useEffect(() => {
    return applyDocumentLocale(document.documentElement, locale);
  }, [locale]);
  const value = useMemo<LocaleContextValue>(() => ({
    locale, setLocale, applyDefaultLocale, dir: localeDirection(locale),
    t: (key, variables) => translate(locale, key, variables),
    money: (minor, currency) => formatMoney(locale, minor, currency),
    date: value => formatDate(locale, value),
  }), [locale, setLocale, applyDefaultLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const locale = useContext(LocaleContext);
  if (!locale) throw new Error("Restaurant locale provider is missing");
  return locale;
}

export function LanguagePicker({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  const id = useId();
  return <div className={`restaurant-language ${className}`}>
    <label htmlFor={id} className="sr-only">{t("common.language")}</label>
    <select id={id} value={locale} aria-label={t("common.language")} onChange={event => {
      if (isLocale(event.target.value)) setLocale(event.target.value);
    }} className="rounded-xl border border-current/20 bg-transparent px-3 py-2 text-sm" dir={localeDirection(locale)}>
      {LOCALES.map(code => <option key={code} value={code} lang={code} dir={localeDirection(code)}>{LANGUAGE_NAMES[code]}</option>)}
    </select>
  </div>;
}
