export type RefundStatus = "requested" | "processing" | "succeeded" | "failed" | "review" | "manual_reported";
export interface Refund {
  id: string; number: string; requestId: string; status: RefundStatus; provider: string; currency: string;
  amountMinor: number; taxMinor: number; reason: string; providerReference?: string; manualReference?: string;
  resolutionReason?: string; confirmation: "none" | "provider" | "manual"; authorized: boolean; submitted: boolean;
  version: number; createdAt: string; updatedAt: string;
}
export interface RefundCapability { automatic: boolean; partial: boolean; manual: boolean; reason: "provider_verified" | "manual_review_required" }
export interface RefundSummary { refunds: Refund[]; capturedMinor: number; reservedMinor: number; refundedMinor: number; availableMinor: number; capability: RefundCapability }
export interface RefundRequest { requestId: string; amountMinor: number; reason: string; version: number }
