import type { ReactNode } from "react";
import type { Settings } from "./types";
import { effectiveBrand, storefrontTemplate } from "./brand";
import { safeMenuImage } from "./customer/cart";
import { useLocale } from "./i18n";
import { ArrowUpRight } from "lucide-react";

export function BrandHero({ settings, fallbackArt }: { settings: Settings; fallbackArt?: ReactNode }) {
  const { t } = useLocale();
  const brand = effectiveBrand(settings);
  if (brand.hideHero) return null;
  const template = storefrontTemplate(brand);
  const cover = safeMenuImage(brand.coverUrl), intro = safeMenuImage(brand.introImageUrl);
  const mainImage = template === "compact" ? "" : template === "editorial" ? intro || cover : cover;
  const description = brand.introText || settings.description;
  const art = mainImage ? <img className="rs-cover-image" src={mainImage} alt={settings.name} referrerPolicy="no-referrer" /> : template === "classic" ? fallbackArt : null;
  const artFirst = template === "editorial" || template === "showcase";
  const illustration = art && <div className="rs-hero-art">{!mainImage && template === "classic" && <div className="rs-hero-orbit" />}{art}</div>;
  return <section className={`rs-hero rs-brand-hero rs-hero-${template}${art ? "" : " rs-hero-no-art"}`}>
    {artFirst && illustration}
    <div className="rs-hero-copy">
      <h1>{brand.introTitle || settings.name}</h1>{description && <p>{description}</p>}
      {template !== "compact" && <div className="rs-hero-actions"><a className="rs-button" href="#menu">{t("store.browse")}<ArrowUpRight size={19} /></a></div>}
      {intro && template !== "editorial" && template !== "compact" && <img className="rs-intro-photo" src={intro} alt={settings.name} loading="lazy" referrerPolicy="no-referrer" />}
    </div>
    {!artFirst && illustration}
  </section>;
}
