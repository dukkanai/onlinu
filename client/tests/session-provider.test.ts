import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getSessionProvider, isSessionReady, supportsSessionCapability } from "../src/lib/session-provider";
import type { SessionInfo } from "../src/types/session";
import type { BrokerEvent } from "../src/lib/event-stream";

const legacy: SessionInfo = { id: "legacy", name: "QR account", jid: "", state: "open", paired: true, recording: false };
const official: SessionInfo = { ...legacy, id: "official", provider: "meta" };

test("existing accounts without a provider keep QR capabilities and readiness", () => {
  assert.equal(getSessionProvider(legacy), "qr");
  assert.equal(isSessionReady(legacy), true);
  for (const capability of ["audio", "video", "recording", "hold", "transfer", "messaging"] as const) {
    assert.equal(supportsSessionCapability(legacy, capability), true, capability);
  }
  assert.equal(supportsSessionCapability({ ...legacy, capabilities: { video: false } }, "video"), false);
});

test("official accounts expose audio only, including when capabilities are omitted", () => {
  assert.equal(getSessionProvider(official), "meta");
  assert.equal(supportsSessionCapability(official, "audio"), true);
  for (const capability of ["video", "recording", "hold", "transfer", "messaging"] as const) {
    assert.equal(supportsSessionCapability(official, capability), false, capability);
    assert.equal(supportsSessionCapability({ ...official, capabilities: { [capability]: true } }, capability), false);
  }
  assert.equal(supportsSessionCapability({ ...official, capabilities: { audio: false } }, "audio"), false);
});

test("configured or failed official accounts cannot appear ready", () => {
  assert.equal(isSessionReady(official), true);
  assert.equal(isSessionReady({ ...official, paired: false }), false);
  assert.equal(isSessionReady({ ...official, state: "configured" }), false);
  assert.equal(isSessionReady({ ...official, state: "error" }), false);
  assert.equal(isSessionReady(null), false);
});

const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});
globalThis.fetch = async () => Response.json({ sessions: [] });
const { eventStream } = await import("../src/lib/event-stream");
let emit: (event: BrokerEvent) => void = () => {};
eventStream.connect = () => {};
eventStream.on = (listener) => { emit = listener; return () => {}; };
const { ensureSessionsWired, useSessions } = await import("../src/stores/sessions");
ensureSessionsWired();
await new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useSessions.setState({ sessions: [], qrs: {}, codes: {}, passkeys: {}, activeId: null });
});

test("logging out clears an already visible QR and pairing code", () => {
  const connecting = { ...legacy, paired: false, state: "qr" as const };
  useSessions.setState({ sessions: [connecting], qrs: { legacy: "stale-qr" }, codes: { legacy: "12345678" } });
  emit({ type: "auth-state", sessionId: "legacy", state: "logged_out", paired: false });
  assert.deepEqual(useSessions.getState().qrs, {});
  assert.deepEqual(useSessions.getState().codes, {});
  assert.equal(useSessions.getState().sessions[0].state, "logged_out");
});

test("session refresh preserves active QR pairing and removes official or deleted artifacts", () => {
  const connecting = { ...legacy, paired: false, state: "qr" as const };
  const configured = { ...official, paired: false, state: "configured" as const };
  useSessions.setState({
    sessions: [connecting, configured], activeId: "official",
    qrs: { legacy: "current-qr", official: "invalid-qr", deleted: "old-qr" },
    codes: { official: "12345678" },
  });
  emit({ type: "session-list", sessions: [connecting, configured] });
  assert.deepEqual(useSessions.getState().qrs, { legacy: "current-qr" });
  assert.deepEqual(useSessions.getState().codes, {});
  assert.equal(useSessions.getState().activeId, "official");
  emit({ type: "session-qr", sessionId: "official", qr: "unexpected-qr" });
  assert.equal(useSessions.getState().qrs.official, undefined);
});
