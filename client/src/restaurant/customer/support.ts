export interface SupportRequest {number:string; scope:string; kind:"cancel"|"complaints"; reason:string; version:number; key:string; createdAt:number; uncertain:boolean}
export const SUPPORT_STORAGE_KEY = "restaurant-support-pending-v1";
export const supportStorageKey = (number:string,scope:string):string => `${SUPPORT_STORAGE_KEY}:${encodeURIComponent(number)}:${encodeURIComponent(scope)}`;
export function parseSupportRequest(raw: string | null, number:string, scope:string, now=Date.now()): SupportRequest | null {
  if (!raw || raw.length > 10000) return null;
  try { const v = JSON.parse(raw);
    if (!v || v.number !== number || v.scope !== scope || !["cancel","complaints"].includes(v.kind) || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 2000 || !Number.isSafeInteger(v.version) || v.version < 1 || typeof v.key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.key) || !Number.isFinite(v.createdAt) || v.createdAt > now + 60000 || now-v.createdAt > 86400000 || typeof v.uncertain !== "boolean") return null;
    return v as SupportRequest;
  } catch { return null; }
}
export interface CustomerRefund {id:string; status:string; provider:string; currency:string; amountMinor:number; taxMinor:number; confirmation:"none"|"provider"|"manual"; createdAt:string; updatedAt:string}
export const refundStatusKey = (refund: CustomerRefund): string => refund.status === "succeeded" && refund.confirmation === "provider" ? "refund.succeeded" : refund.status === "manual_reported" && refund.confirmation === "manual" ? "refund.manual_reported" : ["requested","processing","review","failed"].includes(refund.status) ? `refund.${refund.status}` : "refund.review";
