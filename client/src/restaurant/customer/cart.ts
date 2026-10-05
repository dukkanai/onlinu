import type { Catalog, MenuItem, OrderLineInput } from "../types";

export const CART_STORAGE_KEY = "restaurant-cart-v1";
export function lineKey(
  line: Pick<OrderLineInput, "itemId" | "optionIds">,
): string {
  return `${line.itemId}:${[...new Set(line.optionIds)].sort().join(",")}`;
}
export function normalizeCart(
  raw: unknown,
  catalog: Catalog,
): OrderLineInput[] {
  if (!Array.isArray(raw)) return [];
  const normalized = new Map<string, OrderLineInput>();
  for (const value of raw.slice(0, 100)) {
    if (!value || typeof value !== "object") continue;
    const line = value as Partial<OrderLineInput>;
    const item = catalog.items.find(
      (candidate) => candidate.id === line.itemId && candidate.available,
    );
    if (
      !item ||
      !Number.isInteger(line.quantity) ||
      Number(line.quantity) < 1 ||
      !Array.isArray(line.optionIds)
    )
      continue;
    const optionIds = [
      ...new Set(
        line.optionIds.filter(
          (id) =>
            typeof id === "string" &&
            item.options.some((option) => option.id === id && option.available),
        ),
      ),
    ].sort();
    const next = {
      itemId: item.id,
      quantity: Math.min(99, Number(line.quantity)),
      optionIds,
    };
    const key = lineKey(next);
    const previous = normalized.get(key);
    normalized.set(key, {
      ...next,
      quantity: Math.min(99, next.quantity + (previous?.quantity ?? 0)),
    });
  }
  return [...normalized.values()].slice(0, 50);
}
export function unitPrice(item: MenuItem, optionIds: string[]): number {
  return (
    item.priceMinor +
    item.options
      .filter((option) => optionIds.includes(option.id))
      .reduce((sum, option) => sum + option.priceMinor, 0)
  );
}
export function parseTableCode(value: string, origin: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z0-9_-]{8,128}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, origin);
    if (
      url.origin !== origin ||
      !["/", "/order", "/track"].includes(url.pathname)
    )
      return "";
    const code = url.searchParams.get("table") ?? "";
    return /^[a-zA-Z0-9_-]{8,128}$/.test(code) ? code : "";
  } catch {
    return "";
  }
}
export function privateTrackingURL(
  origin: string,
  number: string,
  token: string,
): string {
  const url = new URL("/track", origin);
  url.searchParams.set("order", number);
  if (token) url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
export function safeMenuImage(value: string): string | undefined {
  if (/^\/restaurant-media\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png)$/.test(value))
    return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      /\.svg(?:$|\/)/i.test(url.pathname)
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
