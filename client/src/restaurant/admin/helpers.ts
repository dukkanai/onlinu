import type { Catalog, Mode, Order, OrderStatus } from "../types";
import { validDeliveryZones } from "../geography";

export const ORDER_STATUSES: readonly OrderStatus[] = ["new", "accepted", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];

export function nextStatuses(mode: Mode, status: OrderStatus): OrderStatus[] {
  if (status === "completed" || status === "cancelled") return [];
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    new: "accepted", accepted: "preparing", preparing: "ready",
    ready: mode === "delivery" ? "out_for_delivery" : "completed",
    ...(mode === "delivery" ? { out_for_delivery: "completed" as const } : {}),
  };
  return next[status] ? [next[status]!, "cancelled"] : ["cancelled"];
}

export function paymentAllowsStatus(order: Order, next: OrderStatus): boolean {
  const payment = order.payment;
  if (!payment?.method || next === "cancelled" || payment.status === "paid") return true;
  if (next === "completed") return false;
  return !(["card", "cash_before"].includes(payment.method) && ["preparing", "ready", "out_for_delivery"].includes(next));
}

export function canCollectCash(order: Order): boolean {
  return !["cancelled", "completed"].includes(order.status) && order.payment?.status === "unpaid" && !order.payment.provider && ["cash_before", "cash_after", "cash_on_delivery"].includes(order.payment.method);
}

// Decimal string parsing avoids floating-point rounding and rejects overprecision.
export function parseMinor(value: string, digits: number): number | null {
  const normalized = value.trim().replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 1776)).replace(/[०-९]/g, digit => String(digit.charCodeAt(0) - 2406)).replace(/[٫,]/g, ".");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(normalized);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const minor = Number(match[1]) * 10 ** digits + Number((match[2] ?? "").padEnd(digits, "0"));
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 100000000 ? minor : null;
}

export function formatMinorInput(minor: number, digits: number): string {
  return (minor / 10 ** digits).toFixed(digits);
}

export function safeMapUrl(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const url = new URL("https://www.openstreetmap.org/");
  url.searchParams.set("mlat", String(latitude));
  url.searchParams.set("mlon", String(longitude));
  url.hash = `map=17/${latitude}/${longitude}`;
  return url.toString();
}

export function safeImageUrl(value: string): boolean {
  if (!value) return true;
  if (value.length > 2048 || /[\\\s]/.test(value)) return false;
  if (/^\/restaurant-media\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png)$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash && !/\.svgz?$/i.test(url.pathname);
  } catch { return false; }
}

export function tableLink(code: string, origin: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("table", code);
  return url.toString();
}

export function validCatalog(catalog: Catalog): boolean {
  const s = catalog.settings;
  const amount = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 100000000;
  if (!s.name.trim() || !/^[A-Z]{3}$/.test(s.currency) || !safeImageUrl(s.logoUrl) || !amount(s.deliveryFeeMinor) || !amount(s.deliveryMinimumMinor)) return false;
  if (!validDeliveryZones(s)) return false;
  if (!safeImageUrl(s.coverUrl ?? "") || [s.primaryColor, s.accentColor, s.backgroundColor].some(color => color !== undefined && !/^#[0-9a-f]{6}$/i.test(color))) return false;
  if (s.taxRateBps !== undefined && (!Number.isInteger(s.taxRateBps) || s.taxRateBps < 0 || s.taxRateBps > 10000)) return false;
  if (s.taxEnabled && !(s.taxNumber ?? "").trim()) return false;
  if (s.paymentMethods) {
    const permitted = { table: ["cash_before", "cash_after", "card"], delivery: ["cash_on_delivery", "card"], pickup: ["card"] };
    for (const mode of ["table", "delivery", "pickup"] as const) {
      const methods = s.paymentMethods[mode];
      if (!Array.isArray(methods) || methods.some(method => !permitted[mode].includes(method)) || new Set(methods).size !== methods.length) return false;
      if (s[`${mode}Enabled`] && methods.length === 0) return false;
    }
  }
  if (s.acceptingOrders && !s.deliveryEnabled && !s.pickupEnabled && !s.tableEnabled) return false;
  if (!Number.isFinite(s.deliveryRadiusKm) || s.deliveryRadiusKm < 0 || s.deliveryRadiusKm > 500 || (s.latitude === null) !== (s.longitude === null)) return false;
  if ((s.latitude !== null || s.deliveryRadiusKm > 0) && !safeMapUrl(s.latitude, s.longitude)) return false;
  const categoryIDs = new Set(catalog.categories.map(c => c.id));
  if (catalog.categories.some(c => !c.name.trim() || !Number.isInteger(c.sort) || c.sort < 0 || c.sort > 10000)) return false;
  if (catalog.items.some(item => !item.name.trim() || !categoryIDs.has(item.categoryId) || !amount(item.priceMinor) || !safeImageUrl(item.imageUrl) || !Number.isInteger(item.sort) || item.sort < 0 || item.sort > 10000 || item.options.some(option => !option.name.trim() || !amount(option.priceMinor)))) return false;
  return !(catalog.tables ?? []).some(table => !table.name.trim());
}
