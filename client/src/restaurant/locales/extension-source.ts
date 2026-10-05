import { adminNextEnglish, adminNextArabic } from "../admin/next-keys";
import { customerNextEnglish, customerNextArabic } from "../customer/nextKeys";

export const extensionEnglish = {
  ...adminNextEnglish,
  ...customerNextEnglish,
  "errors.payment_unavailable": "This payment option is not available. Choose another method.",
  "errors.payment_required": "Payment must be confirmed before this action.",
  "errors.country_required": "Only delivery addresses within Saudi Arabia are supported.",
} as const;

export type ExtensionKey = keyof typeof extensionEnglish;
export type ExtensionDictionary = { [K in ExtensionKey]: string };

export const extensionArabic = {
  ...adminNextArabic,
  ...customerNextArabic,
  "errors.payment_unavailable": "طريقة الدفع هذه غير متاحة. اختر طريقة أخرى.",
  "errors.payment_required": "يجب تأكيد الدفع قبل تنفيذ هذه الخطوة.",
  "errors.country_required": "ندعم عناوين التوصيل داخل السعودية فقط.",
} satisfies ExtensionDictionary;
