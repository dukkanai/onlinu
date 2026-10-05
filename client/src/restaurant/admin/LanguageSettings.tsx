import { isLocale, LANGUAGE_NAMES, LOCALES, normalizeLocale, useLocale } from "../i18n";
import type { Settings } from "../types";
import { Field } from "./Fields";

export function LanguageSettings({ settings, onChange }: {
  settings: Pick<Settings, "defaultLanguage" | "menuLanguage">;
  onChange: (change: Partial<Settings>) => void;
}) {
  const { t } = useLocale();
  return <>
    <Field label={t("admin.defaultLanguage")}>
      <select value={normalizeLocale(settings.defaultLanguage)} onChange={event => {
        if (isLocale(event.target.value)) onChange({ defaultLanguage: event.target.value });
      }}>
        {LOCALES.map(locale => <option key={locale} value={locale}>{LANGUAGE_NAMES[locale]}</option>)}
      </select>
    </Field>
    <Field label={t("admin.menuLanguage")} hint={t("store.menuLanguage")}>
      <select value={isLocale(settings.menuLanguage) ? settings.menuLanguage : ""} onChange={event => {
        if (isLocale(event.target.value)) onChange({ menuLanguage: event.target.value });
      }}>
        {/* The label describes unchanged metadata; it is not another language
            choice and must never silently relabel existing merchant content. */}
        {!isLocale(settings.menuLanguage) && <option value="" disabled>{t("admin.keepMenuLanguage")}</option>}
        {LOCALES.map(locale => <option key={locale} value={locale}>{LANGUAGE_NAMES[locale]}</option>)}
      </select>
    </Field>
  </>;
}
