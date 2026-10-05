import { useEffect, useRef, useState } from "react";
import { Plus, ShoppingBag } from "lucide-react";
import { BrandHero } from "./BrandHero";
import { DishArt } from "./DishArt";
import { MenuTemplate } from "./MenuTemplate";
import { MenuProducts } from "./MenuProducts";
import { brandVariables, storefrontTemplate, type Brand } from "./brand";
import { safeMenuImage } from "./customer/cart";
import { useLocale } from "./i18n";
import type { Catalog } from "./types";
import "./customer/storefront.css";
import "./brand.css";
import "./templates.css";

/** No cart mutations in a draft preview. Uses the same structural components
 * and merchant data as the storefront, not an unrelated template thumbnail. */
export function BrandPreview({ catalog, brand, mobile }: { catalog: Catalog; brand: Brand; mobile: boolean }) {
  const { t, money, dir } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(375);
  useEffect(() => {
    if (!host.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const settings = { ...catalog.settings, brand };
  const template = storefrontTemplate(brand);
  const items = [...catalog.items].sort((a, b) => a.sort - b.sort).slice(0, 6);
  const categories = [...catalog.categories].sort((a, b) => a.sort - b.sort);
  const canvasWidth = mobile ? 375 : 1280;
  return <div ref={host} className="ra-preview-viewport">
    <div className={`restaurant-storefront ra-brand-preview ${mobile ? "ra-brand-mobile" : "ra-brand-desktop"}`} dir={dir} style={{ ...brandVariables(settings), width: canvasWidth, zoom: Math.min(1, width / canvasWidth) }}>
      <div className="ra-preview-heading">{safeMenuImage(brand.logoUrl) && <img src={brand.logoUrl} alt="" referrerPolicy="no-referrer" />}<strong>{settings.name}</strong></div>
      <div className="ra-preview-menu" inert>
        <MenuTemplate template={template}
          hero={<BrandHero settings={settings} fallbackArt={<DishArt variant={2} />} />}
          heading={<div className="rs-section-head rs-menu-heading"><h2>{t("store.menu")}</h2></div>}
          categories={<div className="rs-categories"><button type="button" className="active">{t("store.all")}</button>{categories.map(category => <button type="button" key={category.id}>{category.name}</button>)}</div>}
          notice={settings.taxEnabled && <p className="rs-menu-language">{t("tax.inclusive")}</p>}
          content={<MenuProducts template={template} items={items} categories={categories} renderItem={item => <article className="rs-food-card ra-preview-dish" key={item.id}>
            <div className="rs-food-image">{safeMenuImage(item.imageUrl) ? <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <DishArt variant={-1} />}</div>
            <div className="rs-food-content">{template === "editorial" ? <h4>{item.name}</h4> : <h3>{item.name}</h3>}{item.description && <p>{item.description}</p>}<div><strong>{money(item.priceMinor, settings.currency)}</strong><button type="button" className="rs-add-item" disabled={!item.available} aria-label={t("store.addToCart")}>{item.available ? <Plus size={21} /> : <span>{t("store.unavailable")}</span>}</button></div></div>
          </article>} />}
          sidebar={<section className="rs-panel rs-cart ra-preview-cart"><h2><ShoppingBag size={21} />{t("store.cart")}</h2><p>{t("store.emptyCart")}</p><span className="rs-button ra-preview-cta">{t("store.checkout")}</span></section>}
        />
      </div>
    </div>
  </div>;
}
