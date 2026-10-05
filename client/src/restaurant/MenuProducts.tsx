import type { ReactNode } from "react";
import type { Category, MenuItem } from "./types";
import type { StorefrontTemplate } from "./brand";

export function menuProductGroups(items: MenuItem[], categories: Category[]) {
  const groups = [...categories].sort((a, b) => a.sort - b.sort).map(category => ({
    id: category.id, name: category.name, items: items.filter(item => item.categoryId === category.id),
  })).filter(group => group.items.length > 0);
  const remaining = items.filter(item => !categories.some(category => category.id === item.categoryId));
  if (remaining.length) groups.push({ id: "uncategorized", name: "", items: remaining });
  return groups;
}

export function MenuProducts({ template, items, categories, renderItem }: {
  template: StorefrontTemplate; items: MenuItem[]; categories: Category[];
  renderItem: (item: MenuItem, index: number) => ReactNode;
}) {
  if (template === "editorial") return <div className="rs-editorial-sections">{menuProductGroups(items, categories).map(group => <section className="rs-editorial-section" key={group.id}>
    {group.name && <div className="rs-editorial-category"><h3>{group.name}</h3></div>}
    <div className="rs-food-grid">{group.items.map(renderItem)}</div>
  </section>)}</div>;
  return <div className={`rs-food-grid${template === "compact" ? " rs-food-list" : ""}`}>{items.map(renderItem)}</div>;
}
