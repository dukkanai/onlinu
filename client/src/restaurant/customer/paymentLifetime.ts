import type { Order } from "../types";

// UI cancellation is not payment cancellation. Never retry a sent POST here.
export function createPaymentLifetime() {
  let generation = 0, mounted = false;
  return {
    mount() {
      mounted = true;
      const active = ++generation;
      return () => { if (generation === active) { mounted = false; generation++; } };
    },
    capture() {
      const active = generation;
      return () => mounted && generation === active;
    },
  };
}

// Reconciliation must neither change the selected order nor roll back a newer
// server snapshot that arrived through polling while payment status was read.
export function mergePaymentOrder(current: Order | null, updated: Order): Order | null {
  return current && current.number === updated.number && updated.version >= current.version
    ? updated : current;
}
