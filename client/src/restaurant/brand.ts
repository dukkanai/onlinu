import type { CSSProperties } from "react";
import type { Settings } from "./types";

export const storefrontTemplates = ["classic", "bistro", "editorial", "compact", "showcase"] as const;
export type StorefrontTemplate = typeof storefrontTemplates[number];
export const restaurantFonts = ["system", "serif", "cairo", "amiri", "tajawal"] as const;
export type RestaurantFont = typeof restaurantFonts[number];
export interface Brand {
  template: "classic" | "warm" | "modern";
  storefrontTemplate?: StorefrontTemplate;
  headingFont?: RestaurantFont | ""; bodyFont?: RestaurantFont | ""; buttonFont?: RestaurantFont | "";
  primaryColor: string; primaryTextColor: string; secondaryColor: string; secondaryTextColor: string;
  headingColor: string; bodyColor: string; pageColor: string; cardColor: string; cartColor: string; borderColor: string;
  logoUrl: string; coverUrl: string; introImageUrl: string; introTitle: string; introText: string; hideHero: boolean;
  radius: "square" | "soft" | "round"; shadow: "none" | "soft"; font: "system" | "serif"; imageFit: "cover" | "contain";
  textSize: "normal" | "large"; layout: "grid" | "list";
}
export interface BrandState { version: number; catalogVersion: number; live: Brand; draft: Brand | null; hasPrevious: boolean }
export const brandColorKeys = ["primaryColor", "primaryTextColor", "secondaryColor", "secondaryTextColor", "headingColor", "bodyColor", "pageColor", "cardColor", "cartColor", "borderColor"] as const;
export type BrandColorKey = typeof brandColorKeys[number];
export const isBrandColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);
function luminance(hex: string): number {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }, 0);
}
export function brandContrast(first: string, second: string): number {
  if (!isBrandColor(first) || !isBrandColor(second)) return 0;
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export const contrastText = (background: string): string => brandContrast(background, "#ffffff") >= 4.5 ? "#ffffff" : "#000000";
export const storefrontTemplate = (brand: Brand): StorefrontTemplate => storefrontTemplates.includes(brand.storefrontTemplate as StorefrontTemplate) ? brand.storefrontTemplate! : "classic";
export function restaurantFontFamily(font?: RestaurantFont | "", legacy: Brand["font"] = "system"): string {
  const fallback = "Tahoma, Arial, 'Noto Sans Arabic', 'Noto Sans Devanagari', sans-serif";
  const selected = restaurantFonts.includes(font as RestaurantFont) ? font : legacy;
  return selected === "serif" ? "Georgia, 'Times New Roman', serif" : selected === "cairo" ? `'Astra Cairo', ${fallback}` : selected === "amiri" ? `'Astra Amiri', Georgia, ${fallback}` : selected === "tajawal" ? `'Astra Tajawal', ${fallback}` : fallback;
}
export function effectiveBrand(settings: Settings): Brand {
  if (settings.brand) return settings.brand;
  const primary = isBrandColor(settings.primaryColor ?? "") ? settings.primaryColor! : "#214e40";
  const secondary = isBrandColor(settings.accentColor ?? "") ? settings.accentColor! : "#d6a85f";
  const page = isBrandColor(settings.backgroundColor ?? "") ? settings.backgroundColor! : "#f8f7f2";
  const body = brandContrast(page, "#1f332e") >= 4.5 ? "#1f332e" : contrastText(page);
  const card = brandContrast(body, "#fffefa") >= 4.5 ? "#fffefa" : page;
  return { template: "classic", primaryColor: primary, primaryTextColor: contrastText(primary), secondaryColor: secondary,
    secondaryTextColor: contrastText(secondary), headingColor: body, bodyColor: body, pageColor: page, cardColor: card,
    cartColor: card, borderColor: "#a1a99d", logoUrl: settings.logoUrl, coverUrl: settings.coverUrl || "", introImageUrl: "",
    introTitle: "", introText: "", hideHero: false, radius: "soft", shadow: "soft", font: "system", imageFit: "cover", textSize: "normal", layout: "grid" };
}
export function brandContrastIssues(brand: Brand): [BrandColorKey, BrandColorKey][] {
  const pairs: [BrandColorKey, BrandColorKey][] = [["primaryColor", "primaryTextColor"], ["secondaryColor", "secondaryTextColor"]];
  for (const surface of ["pageColor", "cardColor", "cartColor"] as const) for (const text of ["bodyColor", "headingColor"] as const) pairs.push([surface, text]);
  return pairs.filter(([a, b]) => brandContrast(brand[a], brand[b]) < 4.5);
}
export function brandTemplate(brand: Brand, template: Brand["template"]): Brand {
  const palette = template === "warm" ? { primaryColor: "#733d25", secondaryColor: "#e8c999", pageColor: "#fff7ec", cardColor: "#ffffff", cartColor: "#fff1dc", bodyColor: "#422f25", headingColor: "#422f25", borderColor: "#ab8b70" }
    : template === "modern" ? { primaryColor: "#202939", secondaryColor: "#dde7f8", pageColor: "#f3f5f9", cardColor: "#ffffff", cartColor: "#e9edf5", bodyColor: "#242d3c", headingColor: "#172033", borderColor: "#8c98aa" }
      : { primaryColor: "#214e40", secondaryColor: "#d6a85f", pageColor: "#f8f7f2", cardColor: "#fffefa", cartColor: "#fffefa", bodyColor: "#1f332e", headingColor: "#1f332e", borderColor: "#a1a99d" };
  return { ...brand, ...palette, template, primaryTextColor: contrastText(palette.primaryColor), secondaryTextColor: contrastText(palette.secondaryColor), radius: template === "modern" ? "square" : "soft", shadow: "soft" };
}
export function brandVariables(settings: Settings): CSSProperties {
  const b = effectiveBrand(settings);
  return { "--rs-green": b.primaryColor, "--rs-primary-ink": b.primaryTextColor, "--rs-accent": b.secondaryColor,
    "--rs-accent-ink": b.secondaryTextColor, "--rs-bg": b.pageColor, "--rs-page-ink": b.bodyColor,
    "--rs-page-muted": b.bodyColor, "--rs-panel-action-ink": b.headingColor, "--rs-ink": b.bodyColor,
    "--rs-muted": b.bodyColor, "--rs-heading": b.headingColor, "--rs-paper": b.cardColor,
    "--rs-card": b.cardColor, "--rs-cart": b.cartColor, "--rs-line": b.borderColor,
    "--rs-radius": b.radius === "square" ? "4px" : b.radius === "round" ? "24px" : "14px",
    "--rs-shadow": b.shadow === "none" ? "none" : "0 8px 28px #0000000d",
    "--rs-font": restaurantFontFamily(b.bodyFont, b.font),
    "--restaurant-body-font": restaurantFontFamily(b.bodyFont, b.font),
    "--restaurant-heading-font": restaurantFontFamily(b.headingFont, b.font),
    "--restaurant-button-font": restaurantFontFamily(b.buttonFont, b.font),
    "--rs-image-fit": b.imageFit, "--rs-font-size": b.textSize === "large" ? "17px" : "15px",
    "--rs-food-columns": b.layout === "list" ? "1fr" : "repeat(2,minmax(0,1fr))",
    "--rs-food-columns-wide": b.layout === "list" ? "1fr" : "repeat(3,minmax(0,1fr))" } as CSSProperties;
}
