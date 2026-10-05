import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { getClientId } from "@/lib/client-id";
import { apiUrl, getApiKey } from "@/lib/auth";
import type { MetaPermission, MetaSessionInput, MetaSessionSettings, SessionInfo } from "@/types/session";

export const listSessions = () =>
  apiGet<{ sessions: SessionInfo[] }>("/api/sessions").then((r) => r.sessions ?? []);

export const createSession = (name: string, meta?: MetaSessionInput) =>
  apiPost<{ id: string }>("/api/sessions", meta ? { name, provider: "meta", meta } : { name });

export const getMetaSettings = (id: string) =>
  apiGet<MetaSessionSettings>(`/api/sessions/${id}/meta`);

export const updateMetaSettings = async (id: string, settings: MetaSessionInput): Promise<void> => {
  const r = await fetch(apiUrl(`/api/sessions/${id}/meta`), {
    method: "PUT",
    headers: { "X-Client-Id": getClientId(), "X-API-Key": getApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!r.ok) {
    let message = `Configuração Meta: ${r.status}`;
    try {
      const result = await r.json();
      if (typeof result.error === "string") message = result.error;
    } catch { /* Keep the HTTP status if the response is not JSON. */ }
    throw new Error(message);
  }
};

export const verifyMetaSettings = (id: string) =>
  apiPost<MetaSessionSettings>(`/api/sessions/${id}/meta/verify`, {});

export const getMetaPermission = (id: string, phone: string) =>
  apiGet<MetaPermission>(`/api/sessions/${id}/meta/permissions?phone=${encodeURIComponent(phone)}`);

export const requestMetaPermission = (id: string, phone: string) =>
  apiPost<MetaPermission>(`/api/sessions/${id}/meta/permissions`, { phone });

export const deleteSession = (id: string) => apiDelete(`/api/sessions/${id}`);

const postVoid = async (path: string): Promise<void> => {
  const r = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "X-Client-Id": getClientId(), "X-API-Key": getApiKey(), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
};

export const logoutSession = (id: string) => postVoid(`/api/sessions/${id}/logout`);

export const pairSession = (id: string) => postVoid(`/api/sessions/${id}/pair`);

// Pareamento por CÓDIGO (sem QR): envia o número (só dígitos, com DDI) e recebe
// o código de 8 caracteres que o dono digita no WhatsApp em
// Aparelhos conectados → Conectar com número de telefone.
export const pairSessionCode = (id: string, phone: string) =>
  apiPost<{ code: string }>(`/api/sessions/${id}/pair-code`, { phone });

export const submitPasskeyAssertion = (id: string, assertion: unknown) =>
  apiPost<{ ok: boolean }>(`/api/sessions/${id}/pair-passkey`, assertion);

export const setRecording = async (id: string, enabled: boolean): Promise<void> => {
  const r = await fetch(apiUrl(`/api/sessions/${id}/recording`), {
    method: "PUT",
    headers: { "X-Client-Id": getClientId(), "X-API-Key": getApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`recording ${r.status}`);
};

export const getProxy = (id: string) =>
  apiGet<{ proxy: string; enabled: boolean }>(`/api/sessions/${id}/proxy`);

export const setProxy = async (id: string, proxy: string): Promise<void> => {
  const r = await fetch(apiUrl(`/api/sessions/${id}/proxy`), {
    method: "PUT",
    headers: { "X-Client-Id": getClientId(), "X-API-Key": getApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ proxy }),
  });
  if (!r.ok) {
    let msg = `proxy ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
};
