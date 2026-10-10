import type { Quote } from "../types";

// Keep the versioned positional encoding byte-identical to the original Go
// order core and the control plane, including Go's HTML/Unicode escaping.
export async function quoteBinding(quote: Quote): Promise<string> {
  const tax = quote.tax;
  const text = (value: unknown): value is string => typeof value === "string" && value.length <= 4096;
  const amount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!tax || typeof tax.enabled !== "boolean" || !amount(tax.rateBps) || tax.rateBps > 10000 || !text(tax.number) ||
    !amount(tax.netMinor) || !amount(tax.taxMinor) || !amount(tax.grossMinor) ||
    tax.netMinor + tax.taxMinor !== tax.grossMinor || tax.grossMinor !== quote.totalMinor ||
    !text(quote.currency) || !/^[A-Z]{3}$/.test(quote.currency) || typeof quote.demo !== "boolean" ||
    !amount(quote.subtotalMinor) || !amount(quote.deliveryFeeMinor) || !amount(quote.totalMinor) ||
    quote.subtotalMinor + quote.deliveryFeeMinor !== quote.totalMinor ||
    (quote.tableName !== undefined && !text(quote.tableName)) ||
    !Array.isArray(quote.paymentMethods) || quote.paymentMethods.some(method =>
      !["cash_before", "cash_after", "cash_on_delivery", "card"].includes(method)) ||
    !Array.isArray(quote.items) || quote.items.length < 1 || quote.items.length > 50 ||
    quote.items.some(item => !item || !text(item.itemId) || !text(item.name) ||
      !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 ||
      !amount(item.unitPriceMinor) || !amount(item.totalMinor) ||
      !Array.isArray(item.options) || item.options.length > 30 || item.options.some(option =>
        !option || !text(option.id) || !text(option.name) || !amount(option.priceMinor) || typeof option.available !== "boolean")))
    throw new Error("invalid_quote");
  const data = JSON.stringify([
    "onlinu-quote-v1", quote.currency, quote.subtotalMinor,
    quote.deliveryFeeMinor, quote.totalMinor, quote.demo, quote.tableName ?? "",
    quote.paymentMethods,
    [tax.enabled, tax.rateBps, tax.number, tax.netMinor, tax.taxMinor, tax.grossMinor],
    quote.items.map(item => [
      item.itemId, item.name, item.quantity, item.unitPriceMinor, item.totalMinor,
      item.options.map(option => [option.id, option.name, option.priceMinor, option.available]),
    ]),
  ]).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
