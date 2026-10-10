import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionaries, english, iterations, iterationEnglish } from "../src/restaurant/locales";
import { english as baseEnglish } from "../src/restaurant/locales/en";
import { extensions, extensionEnglish, type ExtensionKey } from "../src/restaurant/locales/extension";
import { completions, completionEnglish } from "../src/restaurant/locales/completion";
import type { Locale } from "../src/restaurant/types";
import {
  LOCALES, LANGUAGE_NAMES, LOCALE_STORAGE_KEY, LanguagePicker, LocaleProvider,
  applyDocumentLocale, currencyMinorDigits, formatDate, formatMoney, initialLocale,
  isLocale, localeDirection, localeWithDefault, normalizeLocale, readLocalePreference, translate,
} from "../src/restaurant/i18n";

const placeholders = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();

test("Arabic and English are the only restaurant dictionaries and cover every fixed UI key and placeholder", () => {
  const keys = Object.keys(english).sort();
  assert.deepEqual(LOCALES, ["ar", "en"]);
  for (const bundle of [dictionaries, extensions, completions, iterations]) assert.deepEqual(Object.keys(bundle).sort(), ["ar", "en"]);
  assert.ok(keys.length > 400, "check the complete customer, admin, courier and payment dictionaries");
  for (const locale of LOCALES) {
    const dictionary = dictionaries[locale];
    assert.deepEqual(Object.keys(dictionary).sort(), keys, `${locale}: missing or unexpected translation keys`);
    let translated = 0;
    for (const key of keys as (keyof typeof english)[]) {
      assert.equal(typeof dictionary[key], "string", `${locale}.${key}`);
      assert.ok(dictionary[key].trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(dictionary[key]), placeholders(english[key]), `${locale}.${key}: interpolation differs`);
      if (dictionary[key] !== english[key]) translated++;
      if (locale !== "en" && key.startsWith("errors.")) assert.notEqual(dictionary[key], english[key], `${locale}.${key}: untranslated error`);
    }
    if (locale !== "en") assert.ok(translated / keys.length > 0.85, `${locale}: English is not a substitute for a translated dictionary`);
  }
});

test("operation extensions are complete translations rather than English fallbacks", () => {
  const keys = Object.keys(extensionEnglish).sort() as ExtensionKey[];
  assert.ok(keys.length > 100, "include all operation labels and error messages");
  for (const key of keys) assert.ok(!Object.hasOwn(baseEnglish, key), `${key}: operation key overwrites an existing label`);
  for (const locale of LOCALES) {
    const extension = extensions[locale];
    assert.deepEqual(Object.keys(extension).sort(), keys, `${locale}: extension key mismatch`);
    let translated = 0;
    for (const key of keys) {
      assert.ok(extension[key].trim(), `${locale}.${key}: empty operation label`);
      assert.deepEqual(placeholders(extension[key]), placeholders(extensionEnglish[key]), `${locale}.${key}: operation placeholders differ`);
      if (extension[key] !== extensionEnglish[key]) translated++;
      if (locale !== "en" && key.startsWith("errors.")) assert.notEqual(extension[key], extensionEnglish[key], `${locale}.${key}: untranslated operation error`);
      assert.equal(dictionaries[locale][key], extension[key], `${locale}.${key}: runtime does not use localized extension`);
    }
    if (locale !== "en") assert.ok(translated / keys.length > 0.85, `${locale}: English fallback must not replace operation translations`);
  }
});

test("theme, geography and reopening bundles are fully localized in both interface languages", () => {
  const keys = Object.keys(iterationEnglish).sort() as (keyof typeof iterationEnglish)[];
  const properNames = new Set(["brand.cairo", "brand.amiri", "brand.tajawal"]);
  assert.ok(keys.length >= 83, "include theme, delivery labels, reopening and errors");
  for (const key of keys) {
    assert.ok(!Object.hasOwn(baseEnglish, key) && !Object.hasOwn(extensionEnglish, key) && !Object.hasOwn(completionEnglish, key), `${key}: iteration overwrites an existing label`);
  }
  for (const locale of LOCALES) {
    const bundle = iterations[locale];
    assert.deepEqual(Object.keys(bundle).sort(), keys, `${locale}: iteration key mismatch`);
    for (const key of keys) {
      assert.ok(bundle[key].trim(), `${locale}.${key}: empty iteration label`);
      assert.deepEqual(placeholders(bundle[key]), placeholders(iterationEnglish[key]), `${locale}.${key}: iteration placeholders differ`);
      assert.equal(dictionaries[locale][key], bundle[key], `${locale}.${key}: runtime must use the localized iteration`);
      if (locale !== "en" && !properNames.has(key)) {
        assert.notEqual(bundle[key], iterationEnglish[key], `${locale}.${key}: English fallback is not a translation`);
      }
    }
  }
});

test("all literal restaurant UI labels and backend error codes have translations", () => {
  const uiRoot = fileURLToPath(new URL("../src/restaurant/", import.meta.url));
  const serverRoot = fileURLToPath(new URL("../../cmd/server/", import.meta.url));
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === "locales" ? [] : files(join(directory, entry.name))) : [join(directory, entry.name)],
  );
  for (const file of files(uiRoot).filter(file => /\.tsx?$/.test(file))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([A-Za-z][\w.-]+)["']/g)) {
      assert.ok(Object.hasOwn(english, match[1]), `${file}: unknown UI key ${match[1]}`);
    }
  }
  for (const name of readdirSync(serverRoot).filter(name => /^restaurant.*\.go$/.test(name) && !name.endsWith("_test.go"))) {
    const source = readFileSync(join(serverRoot, name), "utf8");
    for (const match of source.matchAll(/restaurantFail\([^,\n]+,\s*"([a-z_]+)"/g)) {
      assert.ok(Object.hasOwn(english, `errors.${match[1]}`), `${name}: untranslated API error ${match[1]}`);
    }
  }
});

test("completion dictionaries independently cover Arabic, English and safety wording", () => {
  const keys = Object.keys(completionEnglish).sort() as (keyof typeof completionEnglish)[];
  assert.ok(keys.length >= 170); // Conversation archive labels were removed with WhatsApp.
  for (const key of keys) assert.ok(!Object.hasOwn(baseEnglish, key) && !Object.hasOwn(extensionEnglish, key), `${key}: completion overwrites an existing label`);
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(completions[locale]).sort(), keys, `${locale}: incomplete completion dictionary`);
    let translated = 0;
    for (const key of keys) {
      const value = completions[locale][key];
      assert.ok(value.trim(), `${locale}.${key}: empty text`);
      assert.deepEqual(placeholders(value), placeholders(completionEnglish[key]), `${locale}.${key}: placeholders`);
      assert.equal(dictionaries[locale][key], value);
      if (value !== completionEnglish[key]) translated++;
    }
    if (locale !== "en") assert.ok(translated / keys.length > .9, `${locale}: untranslated completion text`);
  }
});

test("rejected HTTP methods have explicit Arabic and English errors", () => {
  assert.equal(translate("en", "errors.method_not_allowed"), "This request method is not allowed.");
  assert.equal(translate("ar", "errors.method_not_allowed"), "طريقة إرسال هذا الطلب غير مسموح بها.");
});

test("interpolation inserts literal values without translating menu content", () => {
  for (const locale of LOCALES) {
    const table = "طاولة خاصة <script> & {amount}";
    const rendered = translate(locale, "order.moveToTable", { table });
    assert.ok(rendered.includes(table));
    assert.ok(!rendered.includes("{table}"));
    assert.ok(rendered.includes("{amount}"), "inserted values must not be interpreted as a second template");
    assert.equal(translate(locale, "does.not.exist"), dictionaries[locale]["common.error"]);
    assert.equal(translate(locale, "__proto__"), dictionaries[locale]["common.error"]);
  }
});

test("Arabic is the initial fallback; explicit saved choices override restaurant defaults", () => {
  const empty = { getItem: (_: string) => null };
  assert.equal(initialLocale(undefined, empty), "ar");
  assert.deepEqual(readLocalePreference("ar", empty), { locale: "ar", explicitPreference: false });
  assert.deepEqual(localeWithDefault(readLocalePreference("ar", empty), "en"), { locale: "en", explicitPreference: false });
  const saved = { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? "en" : null };
  assert.deepEqual(localeWithDefault(readLocalePreference("ar", saved), "ar"), { locale: "en", explicitPreference: true });
  assert.equal(initialLocale("ar", { getItem: () => "xx" }), "ar");
  assert.equal(initialLocale("ar", { getItem: () => { throw new Error("blocked storage"); } }), "ar");
  assert.equal(isLocale("ar-SA"), false);
  assert.equal(isLocale("ps"), false);
});

test("removed browser languages and legacy defaults fall back without a dictionary crash", () => {
  for (const removed of ["tr", "ps", "fa", "ru", "uk", "fr", "es", "sw", "ha", "ur", "hi", "unknown", "__proto__"]) {
    const storage = { getItem: () => removed };
    assert.equal(isLocale(removed), false);
    assert.deepEqual(readLocalePreference("en", storage), { locale: "en", explicitPreference: false });
    assert.deepEqual(readLocalePreference(removed, storage), { locale: "ar", explicitPreference: false });
    assert.deepEqual(localeWithDefault(readLocalePreference("ar", storage), "en"), { locale: "en", explicitPreference: false });
    assert.deepEqual(localeWithDefault(readLocalePreference("en", storage), removed), { locale: "ar", explicitPreference: false });
    assert.equal(translate(removed as Locale, "common.language"), dictionaries.ar["common.language"]);
    assert.equal(localeDirection(removed as Locale), "rtl");
    assert.equal(formatMoney(removed as Locale, 1500), formatMoney("ar", 1500));
    assert.equal(formatDate(removed as Locale, "2026-09-30"), formatDate("ar", "2026-09-30"));
    const html = renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: removed as Locale, children: createElement(LanguagePicker) }));
    assert.match(html, /<option[^>]*value="ar"[^>]*selected=""/);
  }
  assert.equal(normalizeLocale(null), "ar");
  assert.equal(normalizeLocale(undefined), "ar");
  assert.equal(initialLocale("fr", { getItem: () => { throw new Error("blocked storage"); } }), "ar");
  assert.deepEqual(localeWithDefault({ locale: "en", explicitPreference: true }, "fr"), { locale: "en", explicitPreference: true });
});

test("RTL locales update document language and direction without leaking into other applications", () => {
  for (const locale of LOCALES) {
    const rtl = locale === "ar";
    assert.equal(localeDirection(locale), rtl ? "rtl" : "ltr");
    const root = { lang: "en", dir: "ltr" };
    const restore = applyDocumentLocale(root, locale);
    assert.equal(root.lang, locale);
    assert.equal(root.dir, rtl ? "rtl" : "ltr");
    restore();
    assert.deepEqual(root, { lang: "en", dir: "ltr" });
  }
});

test("currency formatting respects ISO minor-unit precision", () => {
  assert.equal(currencyMinorDigits("SAR"), 2);
  assert.equal(currencyMinorDigits("JPY"), 0);
  assert.equal(currencyMinorDigits("XOF"), 0);
  assert.equal(currencyMinorDigits("KWD"), 3);
  assert.equal(currencyMinorDigits("BHD"), 3);
  assert.equal(formatMoney("en", 12345, "SAR"), new Intl.NumberFormat("en", { style: "currency", currency: "SAR" }).format(123.45));
  assert.equal(formatMoney("en", 12345, "JPY"), new Intl.NumberFormat("en", { style: "currency", currency: "JPY" }).format(12345));
  assert.equal(formatMoney("en", 12345, "KWD"), new Intl.NumberFormat("en", { style: "currency", currency: "KWD" }).format(12.345));
  assert.equal(formatMoney("ar", 12345), new Intl.NumberFormat("ar", { style: "currency", currency: "SAR" }).format(123.45));
  assert.equal(formatMoney("en", Number.NaN), "—");
  assert.equal(formatMoney("en", 1.5), "—");
  assert.equal(formatMoney("en", 100, "invalid"), "—");
  assert.throws(() => currencyMinorDigits("invalid"), RangeError);
});

test("dates and language picker use the selected locale and accessible native labels", () => {
  assert.equal(formatDate("ar", "not-a-date"), "—");
  const value = new Date("2026-09-26T12:00:00Z");
  for (const locale of LOCALES) {
    assert.equal(formatDate(locale, value), new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value));
  }
  const html = renderToStaticMarkup(createElement(LocaleProvider, { children: createElement(LanguagePicker) }));
  assert.ok(html.includes(`aria-label="${english["common.language"]}"`) === false, "initial picker label must be Arabic");
  assert.ok(html.includes(`aria-label="${dictionaries.ar["common.language"]}"`));
  for (const locale of LOCALES) assert.ok(html.includes(LANGUAGE_NAMES[locale]), `${locale}: missing native name`);
  assert.equal((html.match(/<option /g) ?? []).length, 2);
});
