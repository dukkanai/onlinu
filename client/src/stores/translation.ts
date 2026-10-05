import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiGet } from "@/lib/api";

export type TranslationPreference = { enabled: boolean; language: string };
export const defaultTranslation: TranslationPreference = {
  enabled: false,
  language: "en",
};

export const useTranslation = create<{
  sessions: Record<string, TranslationPreference>;
  set: (sid: string, patch: Partial<TranslationPreference>) => void;
}>()(
  persist(
    (set) => ({
      sessions: {},
      set: (sid, patch) =>
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sid]: { ...(state.sessions[sid] ?? defaultTranslation), ...patch },
          },
        })),
    }),
    { name: "astracalls.translation", version: 1 },
  ),
);

export const translationPreference = (sid: string): TranslationPreference =>
  useTranslation.getState().sessions[sid] ?? defaultTranslation;

export async function checkTranslation(
  preference: TranslationPreference,
): Promise<void> {
  if (!preference.enabled) return;
  const config = await apiGet<{ translationEnabled: boolean }>("/api/config");
  if (!config.translationEnabled) {
    throw new Error(
      "الترجمة غير مفعلة على الخادم. يلزم ضبط OPENAI_API_KEY وWACALLS_API_KEY.",
    );
  }
}
