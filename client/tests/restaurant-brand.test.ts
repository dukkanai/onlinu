import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brandContrast, brandContrastIssues, brandTemplate, brandVariables, effectiveBrand, restaurantFontFamily, storefrontTemplates } from "../src/restaurant/brand";
import { BrandHero } from "../src/restaurant/BrandHero";
import { MenuProducts, menuProductGroups } from "../src/restaurant/MenuProducts";
import { MenuTemplate } from "../src/restaurant/MenuTemplate";
import { LocaleProvider } from "../src/restaurant/i18n";
import type { Category, MenuItem, Settings } from "../src/restaurant/types";

const settings = { logoUrl: "", primaryColor: "#214e40", accentColor: "#d6a85f", backgroundColor: "#f8f7f2" } as Settings;
test("brand templates have readable text on every managed surface", () => {
  const original = effectiveBrand(settings);
  assert.equal(brandContrast("#000000", "#ffffff"), 21);
  assert.equal(brandContrast("invalid", "#ffffff"), 0);
  for (const template of ["classic", "warm", "modern"] as const) {
    const brand = brandTemplate({ ...original, introTitle: "Preserved", coverUrl: "https://example.com/restaurant.jpg" }, template);
    assert.deepEqual(brandContrastIssues(brand), []);
    assert.equal(brand.introTitle, "Preserved");
    assert.equal(brand.coverUrl, "https://example.com/restaurant.jpg");
    assert.equal(brandVariables({ ...settings, brand })["--rs-green" as keyof React.CSSProperties], brand.primaryColor);
  }
  assert.ok(brandContrastIssues({ ...original, bodyColor: original.cardColor }).length > 0);
});
test("legacy light/dark appearance normalizes to readable defaults without a draft", () => {
  for (const backgroundColor of ["#ffffff", "#000000", "#888888", "bad"]) assert.deepEqual(brandContrastIssues(effectiveBrand({ ...settings, backgroundColor })), []);
  assert.equal(effectiveBrand(settings).hideHero, false);
});

test("font roles remain independent and omitted roles preserve the legacy family", () => {
  const original = { ...effectiveBrand(settings), font: "serif" as const };
  const vars = brandVariables({ ...settings, brand: { ...original, headingFont: "amiri", buttonFont: "tajawal" } }) as Record<string, string>;
  assert.match(vars["--restaurant-heading-font"], /^'Astra Amiri'/);
  assert.match(vars["--restaurant-button-font"], /^'Astra Tajawal'/);
  assert.equal(vars["--restaurant-body-font"], restaurantFontFamily("serif"));
  assert.equal(vars["--rs-font"], vars["--restaurant-body-font"]);
  assert.match(restaurantFontFamily("cairo"), /Noto Sans Devanagari/);
  const legacy = brandVariables({ ...settings, brand: original }) as Record<string, string>;
  for (const role of ["body", "heading", "button"]) assert.equal(legacy[`--restaurant-${role}-font`], restaurantFontFamily("serif"));
  assert.equal(original.headingFont, undefined);
  const changedLegacy = brandVariables({ ...settings, brand: { ...original, font: "system", headingFont: "amiri" } }) as Record<string, string>;
  assert.equal(changedLegacy["--restaurant-body-font"], restaurantFontFamily("system"));
  assert.equal(changedLegacy["--restaurant-button-font"], restaurantFontFamily("system"));
  assert.equal(changedLegacy["--restaurant-heading-font"], vars["--restaurant-heading-font"]);
  assert.equal(restaurantFontFamily("", "serif"), restaurantFontFamily(undefined, "serif"));
});

test("color presets do not replace the selected structural layout or typography", () => {
  const original = { ...effectiveBrand(settings), storefrontTemplate: "editorial" as const, headingFont: "amiri" as const, bodyFont: "cairo" as const, buttonFont: "tajawal" as const, layout: "list" as const };
  const before = structuredClone(original);
  for (const preset of ["classic", "warm", "modern"] as const) {
    const next = brandTemplate(original, preset);
    for (const key of ["storefrontTemplate", "headingFont", "bodyFont", "buttonFont", "layout"] as const) assert.equal(next[key], original[key]);
    assert.equal((brandVariables({ ...settings, brand: next }) as Record<string, string>)["--rs-food-columns"], "1fr");
  }
  assert.deepEqual(original, before);
});

test("every layout renders one copy of each menu, ordering and checkout region", () => {
  for (const template of storefrontTemplates) {
    const output = renderToStaticMarkup(createElement(MenuTemplate, { template, hero: "MERCHANT-INTRO", table: "TABLE-NOTICE", heading: "MENU-HEADING", categories: "CATEGORY-FILTER", notice: "TAX-NOTICE", content: "PRODUCTS", sidebar: "CART-CHECKOUT" }));
    for (const region of ["MERCHANT-INTRO", "TABLE-NOTICE", "MENU-HEADING", "CATEGORY-FILTER", "TAX-NOTICE", "PRODUCTS", "CART-CHECKOUT"]) assert.equal(output.split(region).length - 1, 1, `${template}: ${region}`);
    assert.equal(output.split('id="menu"').length - 1, 1);
  }
});

test("editorial sections retain every original item including uncategorized entries", () => {
  const categories: Category[] = [{ id: "b", name: "Second section", sort: 2 }, { id: "a", name: "First section", sort: 1 }, { id: "empty", name: "Empty section", sort: 3 }];
  const items = [{ id: "first", categoryId: "a", name: "First", priceMinor: 2500 }, { id: "second", categoryId: "b", name: "Second", priceMinor: 4200 }, { id: "other", categoryId: "deleted", name: "Uncategorized", priceMinor: 0 }] as MenuItem[];
  const before = structuredClone({ items, categories });
  const groups = menuProductGroups(items, categories);
  assert.deepEqual(groups.map(group => group.id), ["a", "b", "uncategorized"]);
  assert.equal(groups[0].items[0], items[0]);
  for (const template of storefrontTemplates) {
    const output = renderToStaticMarkup(createElement(MenuProducts, { template, items, categories, renderItem: item => createElement("article", { key: item.id, "data-item-id": item.id }, `${item.name}: ${item.priceMinor}`) }));
    for (const item of items) assert.equal(output.split(`data-item-id="${item.id}"`).length - 1, 1);
    assert.ok(!output.includes("Empty section"));
  }
  assert.deepEqual({ items, categories }, before);
});

test("intro uses merchant copy without invented fallback claims and supports no-image layouts", () => {
  const merchant = { ...settings, name: "Merchant name", description: "", brand: effectiveBrand(settings) };
  const render = (next: Settings) => renderToStaticMarkup(createElement(LocaleProvider, { children: createElement(BrandHero, { settings: next }), defaultLocale: "en" }));
  const empty = render(merchant);
  assert.match(empty, /<h1>Merchant name<\/h1>/);
  assert.ok(!empty.includes("<p>"));
  assert.ok(!empty.includes("<img"));
  assert.equal(render({ ...merchant, brand: { ...merchant.brand, hideHero: true } }), "");
  const withImage = { ...merchant.brand, coverUrl: "/restaurant-media/test.png", introTitle: "Merchant story" };
  const editorial = render({ ...merchant, brand: { ...withImage, storefrontTemplate: "editorial" } });
  assert.ok(editorial.indexOf("rs-hero-art") < editorial.indexOf("rs-hero-copy"));
  assert.equal(editorial.split("Merchant story").length - 1, 1);
  const compact = render({ ...merchant, brand: { ...withImage, storefrontTemplate: "compact" } });
  assert.ok(!compact.includes("<img"));
  assert.ok(!compact.includes('href="#menu"'));
});

test("bundled fonts match the source manifest and include local license notices", () => {
  const fontsRoot = new URL("../public/fonts/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("SOURCES.json", fontsRoot), "utf8")) as { families: { name: string; licenseFile: string }[]; files: { file: string; bytes: number; sha256: string }[] };
  assert.deepEqual(manifest.families.map(family => family.name).sort(), ["Amiri", "Cairo", "Tajawal"]);
  for (const entry of manifest.files) {
    const content = readFileSync(new URL(entry.file, fontsRoot));
    assert.equal(content.byteLength, entry.bytes, entry.file);
    assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256, entry.file);
    if (entry.file.endsWith(".woff2")) assert.equal(content.subarray(0, 4).toString(), "wOF2", entry.file);
  }
  for (const family of manifest.families) assert.match(readFileSync(new URL(family.licenseFile, fontsRoot), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});
