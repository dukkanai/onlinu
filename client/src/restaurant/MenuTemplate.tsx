import type { ReactNode } from "react";
import type { StorefrontTemplate } from "./brand";

/** Shared by the live menu and draft preview: template choices rearrange
 * content, never duplicate order/cart state or modify the merchant catalog. */
export function MenuTemplate({ template, hero, table, heading, categories, notice, content, sidebar }: {
  template: StorefrontTemplate; hero?: ReactNode; table?: ReactNode;
  heading: ReactNode; categories: ReactNode; notice?: ReactNode;
  content: ReactNode; sidebar: ReactNode;
}) {
  const menuContent = <div className="rs-template-products">{notice}{content}</div>;
  if (template === "bistro") return <div className="rs-template rs-template-bistro" data-storefront-template={template}>
    {hero}{table}<div className="rs-template-toolbar" id="menu">{heading}</div>
    <div className="rs-menu-layout rs-bistro-layout"><nav className="rs-template-category-rail">{categories}</nav>{menuContent}<aside>{sidebar}</aside></div>
  </div>;
  if (template === "editorial") return <div className="rs-template rs-template-editorial" data-storefront-template={template}>
    {hero}{table}<div className="rs-template-toolbar" id="menu">{heading}{categories}{notice}</div>
    <div className="rs-menu-layout rs-editorial-layout"><div className="rs-template-products">{content}</div><aside>{sidebar}</aside></div>
  </div>;
  if (template === "compact") return <div className="rs-template rs-template-compact" data-storefront-template={template}>
    <div className="rs-compact-intro">{hero}</div>{table}<div className="rs-menu-layout rs-compact-layout" id="menu"><div>{heading}{categories}{menuContent}</div><aside>{sidebar}</aside></div>
  </div>;
  if (template === "showcase") return <div className="rs-template rs-template-showcase" data-storefront-template={template}>
    {hero}{table}<div className="rs-template-toolbar" id="menu">{heading}{categories}{notice}</div>
    <div className="rs-showcase-layout"><div className="rs-template-products">{content}</div><aside>{sidebar}</aside></div>
  </div>;
  return <div className="rs-template rs-template-classic" data-storefront-template="classic">{hero}{table}<div className="rs-menu-layout" id="menu"><div>{heading}{categories}{menuContent}</div><aside>{sidebar}</aside></div></div>;
}
