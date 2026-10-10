import type { OrderLineInput } from "../types";
import { lineKey } from "./cart";

// This fences UI effects only. Disposing a checkout never cancels or changes
// the identity of an order POST that may already have reached the server.
export function createCheckoutLifetime() {
  let generation = 0, mounted = false;
  return {
    mount() {
      mounted = true;
      generation++;
      return () => { mounted = false; generation++; };
    },
    capture() {
      const current = generation;
      return () => mounted && current === generation;
    },
  };
}

export function clearSubmittedCart(current: OrderLineInput[], submitted: OrderLineInput[]): OrderLineInput[] {
  const signature = (lines: OrderLineInput[]) => JSON.stringify(lines.map(line =>
    [lineKey(line), line.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  // A recovered old submission must not erase anything the customer changed
  // while away. Preserve that newer cart rather than guessing their intent.
  return signature(current) === signature(submitted) ? [] : current;
}
