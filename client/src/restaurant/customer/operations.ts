import type { Address, Mode, PaymentMethod, Settings } from "../types";
export { brandVariables, contrastText } from "../brand";

export const paymentProviderIds = [
  "stripe",
  "paylink",
  "moyasar",
  "tap",
  "hyperpay",
  "paytabs",
  "geidea",
  "myfatoorah",
] as const;
export const deliveryStatuses = [
  "assigned",
  "picked_up",
  "on_the_way",
  "nearby",
  "at_door",
  "delivered",
] as const;
export function availablePaymentMethods(
  settings: Settings,
  mode: Mode,
): PaymentMethod[] {
  const valid: Record<Mode, PaymentMethod[]> = {
    table: ["cash_before", "cash_after", "card"],
    delivery: ["cash_on_delivery", "card"],
    pickup: ["card"],
  };
  return [...new Set(settings.paymentMethods?.[mode] ?? valid[mode])].filter(
    (method) => valid[mode].includes(method),
  );
}
export function withAddressCountry(address: Address, country: string): Address {
  return {
    ...address,
    country,
    ...((address.country || "SA") !== country
      ? { latitude: null, longitude: null, area: "" }
      : {}),
    ...(country !== "SA" ? { nationalAddress: "", additionalNumber: "" } : {}),
  };
}
export function isSaudiDeliveryAddress(address: Pick<Address, "country">): boolean {
  // Missing country is a legacy Saudi address; never relabel an explicit country.
  return !address.country || address.country === "SA";
}
export function paymentStatusKey(status: string | undefined) {
  return `payment.status.${["unpaid", "pending", "paid", "failed", "refunded", "review"].includes(status ?? "") ? status : "legacy"}`;
}
export function mapURL(address: Address): string | null {
  if (
    typeof address.latitude !== "number" ||
    typeof address.longitude !== "number" ||
    !Number.isFinite(address.latitude) ||
    !Number.isFinite(address.longitude) ||
    Math.abs(address.latitude) > 90 ||
    Math.abs(address.longitude) > 180
  )
    return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${address.latitude},${address.longitude}`)}`;
}
export function courierNextStatus(status: string | undefined): string | null {
  const index = deliveryStatuses.indexOf(
    status as (typeof deliveryStatuses)[number],
  );
  return index >= 0 && index < deliveryStatuses.length - 1
    ? deliveryStatuses[index + 1]
    : null;
}
export function printOrderReceipt() {
  const original =
    window.location.pathname + window.location.search + window.location.hash;
  const restore = () => {
    window.history.replaceState(window.history.state, "", original);
    window.removeEventListener("afterprint", restore);
  };
  // Browser print headers can include the page URL. Do not print the private
  // order token, even though it was already kept out of server request URLs.
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
  window.addEventListener("afterprint", restore, { once: true });
  try {
    window.print();
  } catch {
    restore();
  }
}
