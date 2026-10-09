export interface PaymentAttempt {
  attemptId: string;
  status: string;
  provider: string;
  mode?: "test" | "live";
  url?: string;
  widget?: {
    checkoutId: string;
    scriptUrl: string;
    brands: string[];
    returnUrl: string;
  };
}
export interface PaymentReceiptReference {
  number: string;
  token: string;
  customerId: string;
  createdAt: number;
}
const allowedHosts: Record<string, string[]> = {
  stripe: ["checkout.stripe.com"],
  moyasar: ["checkout.moyasar.com"],
  tap: ["checkout.tap.company", "payment.tap.company", "tap.company"],
  paytabs: ["secure.paytabs.sa"],
  geidea: [
    "www.ksamerchant.geidea.net",
    "ksamerchant.geidea.net",
    "merchant.geidea.net",
  ],
  myfatoorah: [
    "sa.myfatoorah.com",
    "demo.myfatoorah.com",
    "portal.myfatoorah.com",
  ],
};
export function safePaymentURL(provider: string, value: string): string | null {
  if (provider === "paylink") {
    return /^https:\/\/paymentpilot\.paylink\.sa\/pay\/info\/[0-9]{1,40}$/.test(value) && !/\s/.test(value) ? value : null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      allowedHosts[provider]?.includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
const validAttempt = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function retainPaymentReceipt(
  attempt: string,
  number: string,
  token: string,
  customerId = "",
) {
  if (
    !validAttempt(attempt) ||
    !/^[A-Za-z0-9_-]{1,40}$/.test(number) ||
    token.length > 512 ||
    customerId.length > 128
  )
    return;
  try {
    const prefix = "restaurant-payment-return:";
    const entries = Object.keys(sessionStorage).filter((key) =>
      key.startsWith(prefix),
    );
    for (const key of entries) {
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
        if (
          !value ||
          typeof value.createdAt !== "number" ||
          Date.now() - value.createdAt > 86_400_000
        )
          sessionStorage.removeItem(key);
      } catch {
        sessionStorage.removeItem(key);
      }
    }
    const retained = Object.keys(sessionStorage).filter((key) =>
      key.startsWith(prefix),
    );
    for (const key of retained.slice(0, Math.max(0, retained.length - 9)))
      sessionStorage.removeItem(key);
    sessionStorage.setItem(
      `restaurant-payment-return:${attempt}`,
      JSON.stringify({ number, token, customerId, createdAt: Date.now() }),
    );
  } catch {
    /* Private tracking link remains the fallback. */
  }
}
export function recoverPaymentReceipt(
  attempt: string,
  now = Date.now(),
): PaymentReceiptReference | null {
  if (!validAttempt(attempt)) return null;
  try {
    const key = `restaurant-payment-return:${attempt}`,
      raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 2048) return null;
    const value = JSON.parse(raw) as Partial<PaymentReceiptReference>;
    if (
      typeof value.number !== "string" ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(value.number) ||
      typeof value.token !== "string" ||
      value.token.length > 512 ||
      typeof value.customerId !== "string" ||
      value.customerId.length > 128 ||
      typeof value.createdAt !== "number" ||
      value.createdAt > now + 60_000 ||
      now - value.createdAt > 86_400_000
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    return value as PaymentReceiptReference;
  } catch {
    return null;
  }
}
const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function isolatedHyperPayDocument(
  attempt: PaymentAttempt,
  origin: string,
): string | null {
  if (
    attempt.provider !== "hyperpay" ||
    attempt.mode !== "test" ||
    !attempt.widget ||
    !validAttempt(attempt.attemptId)
  )
    return null;
  const { checkoutId, scriptUrl, returnUrl, brands } = attempt.widget;
  if (
    !/^[A-Za-z0-9._-]{1,200}$/.test(checkoutId) ||
    !Array.isArray(brands) ||
    !brands.length ||
    brands.some((brand) => !["VISA", "MASTER", "MADA", "AMEX"].includes(brand))
  )
    return null;
  try {
    const script = new URL(scriptUrl),
      returned = new URL(returnUrl);
    if (
      script.origin !== "https://eu-test.oppwa.com" ||
      script.pathname !== "/v1/paymentWidgets.js" ||
      script.searchParams.get("checkoutId") !== checkoutId ||
      script.username ||
      script.password ||
      script.hash ||
      [...script.searchParams.keys()].some((key) => key !== "checkoutId")
    )
      return null;
    const directReturn =
      returned.pathname === "/payment-return" &&
      returned.searchParams.get("attempt") === attempt.attemptId &&
      [...returned.searchParams.keys()].every((key) => key === "attempt");
    const bridgeReturn =
      returned.pathname === `/payment-hooks/return/${attempt.attemptId}` &&
      !returned.search;
    if (
      returned.origin !== origin ||
      (!directReturn && !bridgeReturn) ||
      returned.username ||
      returned.password ||
      returned.hash
    )
      return null;
    // Deliberately no allow-same-origin on the embedding iframe: payment JS
    // cannot access the app's admin credential, cart, or private receipt.
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://eu-test.oppwa.com; style-src 'unsafe-inline' https://eu-test.oppwa.com; frame-src https://*.oppwa.com; connect-src https://*.oppwa.com; img-src https: data:; form-action https: ${escapeHTML(origin)}; base-uri 'none'"></head><body><form class="paymentWidgets" action="${escapeHTML(returned.toString())}" data-brands="${escapeHTML(brands.join(" "))}"></form><script src="${escapeHTML(script.toString())}"></script></body></html>`;
  } catch {
    return null;
  }
}
