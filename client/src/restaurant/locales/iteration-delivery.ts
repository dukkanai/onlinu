import type { Locale } from "../types";
import { iterationDeliveryEnglish, iterationDeliveryArabic } from "./iteration-delivery-source";
import { reopenEN, reopenAR } from "./iteration-reopen-source";

export const deliveryReopenEnglish = { ...iterationDeliveryEnglish, ...reopenEN } as const;
export type DeliveryReopenDictionary = Record<keyof typeof deliveryReopenEnglish, string>;

export const deliveryReopen: Record<Locale, DeliveryReopenDictionary> = {
  en: deliveryReopenEnglish,
  ar: { ...iterationDeliveryArabic, ...reopenAR },
};
