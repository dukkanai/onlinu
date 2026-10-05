import type { OrderInput, Quote } from "../types";
import { isHistoricalRestaurantCountry } from "../countries";

export const PENDING_STORAGE_KEY = "restaurant-pending-order-v1";
export interface PendingSubmission {
  key: string;
  input: OrderInput;
  quote: Quote;
  customerId: string;
  createdAt: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
const amount = (value: unknown) =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) < 1_000_000_000;

export function parsePendingSubmission(
  serialized: string | null,
  now = Date.now(),
): PendingSubmission | null {
  if (!serialized || serialized.length > 100_000) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !record(value) ||
      !text(value.key, 36) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.key,
      ) ||
      !text(value.customerId, 128) ||
      typeof value.createdAt !== "number" ||
      value.createdAt > now + 60_000 ||
      now - value.createdAt > 86_400_000
    )
      return null;
    const input = value.input,
      quote = value.quote;
    if (
      !record(input) ||
      !["delivery", "pickup", "table"].includes(String(input.mode)) ||
      !text(input.customerName, 120) ||
      !text(input.phone, 30) ||
      !text(input.notes, 1000) ||
      !text(input.tableCode, 128) ||
      !amount(input.expectedTotalMinor) ||
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > 50 ||
      !record(input.address)
    )
      return null;
    const methods = ["cash_before", "cash_after", "cash_on_delivery", "card"];
    if (
      input.paymentMethod !== undefined &&
      !methods.includes(String(input.paymentMethod))
    )
      return null;
    if (input.paymentProvider !== undefined && !text(input.paymentProvider, 40))
      return null;
    if (
      input.address.country !== undefined &&
      (typeof input.address.country !== "string" ||
        !isHistoricalRestaurantCountry(input.address.country))
    )
      return null;
    if (
      input.address.country &&
      input.address.country !== "SA" &&
      (input.address.nationalAddress || input.address.additionalNumber)
    )
      return null;
    for (const key of [
      "city",
      "district",
      "street",
      "building",
      "postalCode",
      "additionalNumber",
      "nationalAddress",
      "addressLine",
      "area",
    ])
      if (!text(input.address[key], 500)) return null;
    for (const key of ["latitude", "longitude"])
      if (
        input.address[key] !== null &&
        (typeof input.address[key] !== "number" ||
          !Number.isFinite(input.address[key]))
      )
        return null;
    // Geography IDs are optional for legacy manual addresses, but never accept
    // objects or partial directory addresses from tab recovery storage.
    const geographyAddress = input.address;
    const geographyKeys = ["regionId", "cityId", "districtId"] as const;
    for (const key of geographyKeys)
      if (geographyAddress[key] !== undefined && (!text(geographyAddress[key], 80) || (geographyAddress[key] !== "" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(String(geographyAddress[key]))))) return null;
    if (geographyKeys.some(key => !!geographyAddress[key]) && geographyKeys.some(key => !geographyAddress[key])) return null;
    for (const line of input.items)
      if (
        !record(line) ||
        !text(line.itemId, 128) ||
        !Number.isInteger(line.quantity) ||
        Number(line.quantity) < 1 ||
        Number(line.quantity) > 99 ||
        !Array.isArray(line.optionIds) ||
        line.optionIds.length > 30 ||
        line.optionIds.some((id) => !text(id, 128))
      )
        return null;
    if (
      !record(quote) ||
      !amount(quote.totalMinor) ||
      !amount(quote.subtotalMinor) ||
      !amount(quote.deliveryFeeMinor) ||
      !text(quote.currency, 3) ||
      !/^[A-Z]{3}$/.test(quote.currency) ||
      quote.totalMinor !== input.expectedTotalMinor ||
      !Array.isArray(quote.items) ||
      typeof quote.demo !== "boolean" ||
      (quote.tableName !== undefined && !text(quote.tableName, 120))
    )
      return null;
    if (quote.items.length < 1 || quote.items.length > 50) return null;
    if (
      quote.paymentMethods !== undefined &&
      (!Array.isArray(quote.paymentMethods) ||
        quote.paymentMethods.some(
          (method) => !methods.includes(String(method)),
        ))
    )
      return null;
    if (
      quote.tax !== undefined &&
      (!record(quote.tax) ||
        typeof quote.tax.enabled !== "boolean" ||
        !amount(quote.tax.netMinor) ||
        !amount(quote.tax.taxMinor) ||
        !amount(quote.tax.grossMinor) ||
        quote.tax.grossMinor !== quote.totalMinor ||
        Number(quote.tax.netMinor) + Number(quote.tax.taxMinor) !==
          quote.tax.grossMinor ||
        !text(quote.tax.number, 100) ||
        !Number.isInteger(quote.tax.rateBps) ||
        Number(quote.tax.rateBps) < 0 ||
        Number(quote.tax.rateBps) > 10000)
    )
      return null;
    for (const line of quote.items) {
      if (
        !record(line) ||
        !text(line.itemId, 128) ||
        !text(line.name, 200) ||
        !Number.isInteger(line.quantity) ||
        Number(line.quantity) < 1 ||
        Number(line.quantity) > 99 ||
        !amount(line.unitPriceMinor) ||
        !amount(line.totalMinor) ||
        !Array.isArray(line.options) ||
        line.options.length > 30
      )
        return null;
      for (const option of line.options)
        if (
          !record(option) ||
          !text(option.id, 128) ||
          !text(option.name, 200) ||
          !amount(option.priceMinor) ||
          typeof option.available !== "boolean"
        )
          return null;
    }
    // The server remains authoritative; the stored quote is display-only. Keep
    // only the fields used here, not arbitrary keys injected through storage.
    return {
      key: value.key,
      customerId: value.customerId,
      createdAt: value.createdAt,
      input: input as unknown as OrderInput,
      quote: {
        items: quote.items as unknown as Quote["items"],
        totalMinor: Number(quote.totalMinor),
        subtotalMinor: Number(quote.subtotalMinor),
        deliveryFeeMinor: Number(quote.deliveryFeeMinor),
        currency: quote.currency,
        demo: quote.demo,
        ...(quote.tax ? { tax: quote.tax as unknown as Quote["tax"] } : {}),
        ...(quote.paymentMethods
          ? { paymentMethods: quote.paymentMethods as Quote["paymentMethods"] }
          : {}),
        ...(quote.tableName ? { tableName: String(quote.tableName) } : {}),
      },
    };
  } catch {
    return null;
  }
}
export function readPendingSubmission(): PendingSubmission | null {
  try {
    const saved = sessionStorage.getItem(PENDING_STORAGE_KEY);
    const parsed = parsePendingSubmission(saved);
    if (saved && !parsed) sessionStorage.removeItem(PENDING_STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}
export function savePendingSubmission(value: PendingSubmission | null) {
  // Short-lived, tab-scoped recovery only. Never store passwords, API keys or
  // customer contact/address details in localStorage.
  try {
    if (value)
      sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    /* Retry still works in memory when storage is disabled. */
  }
}
