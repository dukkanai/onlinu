import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse, type AtRule, type Rule } from "postcss";

// Source-level contracts complement the real Chromium/PDF acceptance in
// scripts/restaurant-iteration-font-browser-test.js. They do not replace the
// rendered one-page receipt, long receipt, or admin QR checks.
const stylesheet = parse(readFileSync(new URL("../src/restaurant/customer/storefront.css", import.meta.url), "utf8"));
const print = stylesheet.nodes.find(node => node.type === "atrule" && node.name === "media" && node.params === "print") as AtRule;
assert.ok(print, "receipt print stylesheet exists");
const rules = print.nodes.filter(node => node.type === "rule") as Rule[];
const properties = (selector: string): Record<string, string> => {
  const rule = rules.find(rule => rule.selector === selector);
  assert.ok(rule, `missing print rule: ${selector}`);
  return Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value]));
};

test("receipt print isolation cannot hide admin QR pages without a receipt", () => {
  for (const rule of rules) {
    const hidesContent = rule.nodes.some(node => node.type === "decl" && node.prop === "visibility" && node.value === "hidden");
    if (hidesContent) assert.match(rule.selector, /:has\(\.rs-print-receipt\)/);
  }
  assert.equal(properties(".rs-print-receipt,\n  .rs-print-receipt *").visibility, "visible");
});

test("receipt print keeps normal pagination and groups rows and totals only", () => {
  assert.equal(properties(".rs-print-receipt").position, "static");
  assert.equal(properties(".restaurant-storefront:has(.rs-print-receipt)")["min-height"], "0");
  assert.equal(properties(".restaurant-storefront:has(.rs-print-receipt) :is(.rs-main, .rs-tracking)")["min-height"], "0");
  assert.equal(properties(".restaurant-storefront .rs-print-receipt .rs-panel")["break-inside"], "auto");
  const grouped = rules.find(rule => rule.selector.includes(".rs-cart-line") && rule.selector.includes(".rs-totals"));
  assert.ok(grouped?.nodes.some(node => node.type === "decl" && node.prop === "break-inside" && node.value === "avoid"));
  const hiddenSiblings = rules.find(rule => rule.selector.includes(".rs-tracking:has(.rs-print-receipt) > :not(.rs-print-receipt)"));
  assert.ok(hiddenSiblings?.nodes.some(node => node.type === "decl" && node.prop === "display" && node.value === "none"));
});

test("dark merchant typography prints black on white paper", () => {
  const receipt = properties(".rs-print-receipt");
  assert.equal(receipt["--rs-heading"], "#000");
  assert.equal(receipt["--rs-ink"], "#000");
  assert.equal(receipt.background, "#fff");
  assert.equal(properties(".restaurant-storefront .rs-print-receipt *").color, "#000");
  assert.equal(properties(".restaurant-storefront .rs-print-receipt .rs-panel").background, "#fff");
});
