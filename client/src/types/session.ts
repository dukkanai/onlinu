export type SessionState =
  | "connecting"
  | "qr"
  | "open"
  | "logged_out"
  | "configured"
  | "error"
  | "pairing_code"
  | "passkey_request";

export type SessionInfo = {
  id: string;
  name: string;
  jid: string;
  state: SessionState;
  paired: boolean;
  recording: boolean;
  provider?: "qr" | "meta";
  capabilities?: Partial<SessionCapabilities>;
};

export type SessionCapabilities = {
  audio: boolean;
  video: boolean;
  recording: boolean;
  hold: boolean;
  transfer: boolean;
  messaging: boolean;
};

export type MetaSessionInput = {
  phoneNumberId: string;
  wabaId: string;
  apiVersion: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
};

export type MetaSessionSettings = {
  phoneNumberId: string;
  wabaId: string;
  apiVersion: string;
  webhookUrl: string;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasVerifyToken: boolean;
  verified: boolean;
  webhookVerified: boolean;
  callingEnabled: boolean;
  sipEnabled: boolean;
  lastChecked?: string;
};

export type MetaPermission = {
  status: string;
  canCall?: boolean;
  expiresAt?: number;
};
