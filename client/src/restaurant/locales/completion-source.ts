import { adminCompletionEnglish, adminCompletionArabic } from "../admin/completion-keys";
import { customerCompletionEnglish, customerCompletionArabic } from "../customer/completionKeys";

export const brandEnglish = {
  "brand.draftHint": "Appearance drafts stay private. Save a draft, review it, then publish it to customers.",
  "brand.saveDraft": "Save draft", "brand.publish": "Publish appearance", "brand.revert": "Restore previous appearance",
  "brand.revertConfirm": "Restore the previous published appearance? Menu items and other restaurant settings will not change.",
  "brand.draftSaved": "Draft saved. Customers still see the published appearance.",
  "brand.published": "Appearance published.", "brand.reverted": "Previous appearance restored.", "brand.unsaved": "There are unsaved appearance changes.",
  "brand.template": "Quick style", "brand.classic": "Classic garden", "brand.warm": "Warm hospitality", "brand.modern": "Modern simplicity",
  "brand.introImage": "Additional restaurant photo", "brand.introTitle": "Introduction heading", "brand.introText": "Introduction text",
  "brand.hideHero": "Hide the introduction and show the menu directly", "brand.advanced": "Advanced appearance options",
  "brand.primaryColor": "Primary button background", "brand.primaryTextColor": "Primary button text",
  "brand.secondaryColor": "Secondary button background", "brand.secondaryTextColor": "Secondary button text",
  "brand.headingColor": "Headings", "brand.bodyColor": "Body text", "brand.pageColor": "Page background", "brand.cardColor": "Card background", "brand.cartColor": "Order box background", "brand.borderColor": "Borders",
  "brand.radius": "Corners", "brand.square": "Subtle corners", "brand.soft": "Soft", "brand.round": "Rounded", "brand.shadow": "Card shadows", "brand.none": "None",
  "brand.font": "Font style", "brand.system": "Simple and clear", "brand.serif": "Traditional", "brand.imageFit": "Product photos", "brand.cover": "Fill and crop", "brand.contain": "Show the full photo",
  "brand.textSize": "Text size", "brand.normal": "Normal", "brand.large": "Large", "brand.layout": "Menu layout", "brand.grid": "Card grid", "brand.list": "Single column",
  "brand.contrastFailed": "These text/background pairs need more contrast before saving:",
  "brand.contrastPassed": "Text contrast passes the 4.5:1 readability check.", "brand.mobile": "Mobile", "brand.desktop": "Desktop",
  "brand.previewHint": "This is a responsive appearance sample, not a live customer order. Publishing updates only the appearance.",
  "errors.brand_invalid": "Check the appearance colors, photos and text.", "errors.brand_contrast": "Increase text/background contrast before saving.",
  "errors.brand_changed": "Another administrator changed the appearance. Reload and review it before saving.", "errors.brand_no_draft": "No saved appearance is available for this action.",
} as const;
export const brandArabic: Record<keyof typeof brandEnglish, string> = {
  "brand.draftHint": "تبقى مسودة المظهر خاصة بالإدارة. احفظها وراجعها ثم انشرها للعملاء.",
  "brand.saveDraft": "حفظ المسودة", "brand.publish": "نشر المظهر", "brand.revert": "استعادة المظهر السابق",
  "brand.revertConfirm": "هل تستعيد المظهر المنشور السابق؟ لن تتغير المنتجات أو إعدادات المطعم الأخرى.",
  "brand.draftSaved": "حُفظت المسودة. لا يزال العملاء يرون المظهر المنشور.",
  "brand.published": "نُشر المظهر.", "brand.reverted": "استُعيد المظهر السابق.", "brand.unsaved": "توجد تعديلات مظهر غير محفوظة.",
  "brand.template": "تصميم سريع", "brand.classic": "حديقة كلاسيكية", "brand.warm": "ضيافة دافئة", "brand.modern": "بساطة عصرية",
  "brand.introImage": "صورة إضافية للمطعم", "brand.introTitle": "عنوان المقدمة", "brand.introText": "نص المقدمة",
  "brand.hideHero": "إخفاء المقدمة وعرض المنيو مباشرة", "brand.advanced": "خيارات المظهر المتقدمة",
  "brand.primaryColor": "خلفية الزر الرئيسي", "brand.primaryTextColor": "نص الزر الرئيسي",
  "brand.secondaryColor": "خلفية الزر الثانوي", "brand.secondaryTextColor": "نص الزر الثانوي",
  "brand.headingColor": "العناوين", "brand.bodyColor": "النصوص", "brand.pageColor": "خلفية الصفحة", "brand.cardColor": "خلفية البطاقات", "brand.cartColor": "خلفية صندوق الطلب", "brand.borderColor": "الحدود",
  "brand.radius": "الزوايا", "brand.square": "زوايا خفيفة", "brand.soft": "ناعمة", "brand.round": "مستديرة", "brand.shadow": "ظلال البطاقات", "brand.none": "دون",
  "brand.font": "نمط الخط", "brand.system": "بسيط وواضح", "brand.serif": "تقليدي", "brand.imageFit": "صور المنتجات", "brand.cover": "ملء الإطار مع الاقتصاص", "brand.contain": "عرض الصورة كاملة",
  "brand.textSize": "حجم النص", "brand.normal": "عادي", "brand.large": "كبير", "brand.layout": "ترتيب المنيو", "brand.grid": "شبكة بطاقات", "brand.list": "عمود واحد",
  "brand.contrastFailed": "تحتاج أزواج النص والخلفية التالية إلى تباين أعلى قبل الحفظ:",
  "brand.contrastPassed": "اجتاز تباين النصوص فحص الوضوح بنسبة 4.5:1.", "brand.mobile": "الجوال", "brand.desktop": "الكمبيوتر",
  "brand.previewHint": "هذه عينة متجاوبة للمظهر وليست طلب عميل فعليًا. النشر يحدّث المظهر فقط.",
  "errors.brand_invalid": "راجع ألوان المظهر والصور والنصوص.", "errors.brand_contrast": "ارفع تباين النصوص مع الخلفيات قبل الحفظ.",
  "errors.brand_changed": "عدّل مسؤول آخر المظهر. أعد تحميله وراجعه قبل الحفظ.", "errors.brand_no_draft": "لا يوجد مظهر محفوظ لتنفيذ هذا الإجراء.",
};
export const completionEnglish = { ...brandEnglish, ...adminCompletionEnglish, ...customerCompletionEnglish,
  "errors.version_conflict": "The information changed. Reload and review it before trying again.",
} as const;
export type CompletionDictionary = Record<keyof typeof completionEnglish, string>;
export const completionArabic: CompletionDictionary = { ...brandArabic, ...adminCompletionArabic, ...customerCompletionArabic,
  "errors.version_conflict": "تغيرت البيانات. أعد تحميلها وراجعها قبل المحاولة مجددًا.",
};
