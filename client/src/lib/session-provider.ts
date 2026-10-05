import type { SessionCapabilities, SessionInfo } from "../types/session";

export const getSessionProvider = (session?: Pick<SessionInfo, "provider"> | null): "qr" | "meta" =>
  session?.provider === "meta" ? "meta" : "qr";

/** Legacy accounts retain their existing feature set when capabilities are absent. */
export const supportsSessionCapability = (
  session: Pick<SessionInfo, "provider" | "capabilities"> | null | undefined,
  capability: keyof SessionCapabilities,
): boolean => {
  const supported = session?.capabilities?.[capability];
  if (getSessionProvider(session) === "meta") {
    // This browser integration supports official audio only.
    return capability === "audio" && supported !== false;
  }
  return supported ?? true;
};

export const isSessionReady = (session?: Pick<SessionInfo, "provider" | "state" | "paired"> | null): boolean =>
  Boolean(session?.paired && (getSessionProvider(session) !== "meta" || session?.state === "open"));

export const isPairingState = (state: SessionInfo["state"]): boolean =>
  state === "qr" || state === "connecting" || state === "pairing_code" || state === "passkey_request";
