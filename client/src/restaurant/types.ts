import type { Brand } from "./brand";

export type Locale = "ar" | "en";
export type Mode = "delivery" | "pickup" | "table";
export type PaymentMethod = "cash_before" | "cash_after" | "cash_on_delivery" | "card";
export type PaymentProviderID = "stripe" | "paylink" | "moyasar" | "tap" | "hyperpay" | "paytabs" | "geidea" | "myfatoorah";
export interface TaxSummary { enabled: boolean; rateBps: number; number: string; netMinor: number; taxMinor: number; grossMinor: number }
export interface OrderPayment { method: PaymentMethod | ""; provider: string; status: string; paidAt?: string; amountMinor: number }
export interface Courier { id: string; username: string; name: string; phone: string; active: boolean; availability: "available" | "busy" | "offline"; createdAt: string; updatedAt: string }
export interface DeliveryEvent { status: string; courierId?: string; courierName?: string; actor?: string; at: string }
export type OrderStatus = "new" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "cancelled";
export interface DeliveryZone { districtId: string; enabled: boolean; feeMinor: number | null }
export interface Settings {
  brand?: Brand;
  name: string; description: string; address: string; phone: string; logoUrl: string; currency: string;
  defaultLanguage: Locale; menuLanguage: string; demo: boolean; acceptingOrders: boolean;
  deliveryEnabled: boolean; pickupEnabled: boolean; tableEnabled: boolean;
  deliveryFeeMinor: number; deliveryMinimumMinor: number; deliveryAreas: string[]; deliveryRadiusKm: number;
  deliveryPricingMode?: "flat" | "district"; deliveryZones?: DeliveryZone[];
  latitude: number | null; longitude: number | null; requireDeliveryLocation: boolean;
  pickupInstructions: string; openingHours: string; paymentInstructions: string;
  country?: string; primaryColor?: string; accentColor?: string; backgroundColor?: string; coverUrl?: string;
  taxEnabled?: boolean; taxRateBps?: number; taxNumber?: string;
  paymentMethods?: Record<Mode, PaymentMethod[]>;
}
export interface Category { id: string; name: string; sort: number }
export interface ItemOption { id: string; name: string; priceMinor: number; available: boolean }
export interface MenuItem { id: string; categoryId: string; name: string; description: string; priceMinor: number; imageUrl: string; available: boolean; sort: number; options: ItemOption[] }
export interface RestaurantTable { id: string; name: string; code: string; active: boolean }
export interface Catalog { version: number; settings: Settings; categories: Category[]; items: MenuItem[]; tables?: RestaurantTable[] }
export interface Address { id?: string; label?: string; country?: string; regionId?: string; cityId?: string; districtId?: string; city: string; district: string; street: string; building: string; postalCode: string; additionalNumber: string; nationalAddress: string; addressLine: string; area: string; latitude: number | null; longitude: number | null }
export interface OrderLineInput { itemId: string; quantity: number; optionIds: string[] }
export interface OrderInput { mode: Mode; customerName: string; phone: string; address: Address; tableCode: string; notes: string; items: OrderLineInput[]; expectedTotalMinor: number; expectedQuoteHash?: string; paymentMethod?: PaymentMethod; paymentProvider?: string }
export interface OrderLine { itemId: string; name: string; quantity: number; unitPriceMinor: number; options: ItemOption[]; totalMinor: number }
export interface Quote { items: OrderLine[]; subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number; currency: string; tableName?: string; demo: boolean; paymentMethods?: PaymentMethod[]; tax?: TaxSummary }
export interface StockItem { itemId: string; tracked: boolean; available: number; held: number; version: number; updatedAt: string }
export interface OrderCancellation { id: string; status: "requested" | "approved" | "rejected"; reason: string; decisionReason: string; requestedAt: string; decidedAt?: string; requestedBeforePreparation: boolean }
export interface OrderComplaint { id: string; status: "open" | "resolved"; reason: string; resolution: string; requestedAt: string; resolvedAt?: string }
export interface Order extends Quote { number: string; version: number; status: OrderStatus; mode: Mode; customerName: string; phone: string; address: Address; tableId?: string; tableName?: string; tableChanges: {from: string; to: string; at: string}[]; notes: string; createdAt: string; updatedAt: string; payment?: OrderPayment; courierId?: string; courierName?: string; deliveryStatus?: string; deliveryEvents?: DeliveryEvent[]; stockExpiresAt?: string; preparationStartedAt?: string; cancellation?: OrderCancellation; cancellationHistory?: OrderCancellation[]; complaints?: OrderComplaint[] }
export interface Receipt { order: Order; trackingToken: string; accessCode: string }
export interface Customer { id: string; username: string; displayName: string; phone: string; addresses: Address[] }
export type CustomerUpdate = Pick<Customer, "displayName" | "phone" | "addresses">;
export const emptyAddress = (): Address => ({country: "SA", city: "", district: "", street: "", building: "", postalCode: "", additionalNumber: "", nationalAddress: "", addressLine: "", area: "", latitude: null, longitude: null});
