import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { defaultTranslation, useTranslation } from "@/stores/translation";

export const translationLanguages = [
  ["en", "الإنجليزية"],
  ["fr", "الفرنسية"],
  ["es", "الإسبانية"],
  ["de", "الألمانية"],
  ["pt", "البرتغالية"],
  ["it", "الإيطالية"],
  ["tr", "التركية"],
  ["ru", "الروسية"],
  ["zh", "الصينية"],
  ["ja", "اليابانية"],
  ["ko", "الكورية"],
  ["hi", "الهندية"],
  ["ur", "الأردية"],
  ["fa", "الفارسية"],
  ["id", "الإندونيسية"],
] as const;

export const TranslationSettings = ({
  sid,
  disabled = false,
}: {
  sid: string;
  disabled?: boolean;
}) => {
  const id = useId();
  const pref = useTranslation((s) => s.sessions[sid] ?? defaultTranslation);
  const set = useTranslation((s) => s.set);
  return (
    <div dir="rtl" className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-enabled`} className="text-sm font-medium">
          مترجم المكالمات — OpenAI
        </label>
        <Switch
          id={`${id}-enabled`}
          checked={pref.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => set(sid, { enabled })}
        />
      </div>
      {pref.enabled && (
        <>
          <label htmlFor={`${id}-language`} className="block text-sm">
            لغة الطرف الآخر
          </label>
          <select
            id={`${id}-language`}
            value={pref.language}
            disabled={disabled}
            onChange={(e) => set(sid, { language: e.target.value })}
            className="w-full rounded-md border bg-background p-2 text-sm"
          >
            {translationLanguages.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            يسمع الطرف الآخر ترجمة كلامك، وتسمع رده بالعربية. يطبق الاختيار عند
            بدء المكالمة أو الرد عليها. تتم معالجة صوت الطرفين عبر OpenAI، مع
            تكلفة استخدام وتأخير للترجمة. استخدم سماعات وأبلغ الطرف الآخر
            بالترجمة الآلية.
          </p>
        </>
      )}
    </div>
  );
};
