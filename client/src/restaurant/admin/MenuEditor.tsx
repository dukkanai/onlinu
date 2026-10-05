import { useId, useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Catalog, MenuItem } from "../types";
import { Check, Field, MoneyInput } from "./Fields";
import { safeImageUrl } from "./helpers";

export type CatalogUpdate = (update: (catalog: Catalog) => Catalog) => void;

export function MenuEditor({ catalog, update, reportError, setUploading, onOpenStock }: { catalog: Catalog; update: CatalogUpdate; reportError: (code: string) => void; setUploading: (busy: boolean) => void; onOpenStock?: () => void }) {
  const { t, money } = useLocale();
  const uploadID = useId();
  const [selected, select] = useState(catalog.items[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const item = catalog.items.find(entry => entry.id === selected);
  const patchItem = (id: string, patch: Partial<MenuItem>) => update(current => ({ ...current, items: current.items.map(entry => entry.id === id ? { ...entry, ...patch } : entry) }));
  const addItem = () => {
    const id = crypto.randomUUID();
    update(current => ({ ...current, items: [...current.items, { id, categoryId: current.categories[0]?.id ?? "", name: "", description: "", priceMinor: 0, imageUrl: "", available: true, sort: current.items.length, options: [] }] }));
    select(id);
  };
  async function upload(file: File | undefined, itemId: string) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { reportError("image_too_large"); return; }
    if (!["image/jpeg", "image/png"].includes(file.type)) { reportError("image_invalid"); return; }
    setUploading(true);
    try {
      const body = new FormData(); body.append("image", file);
      const result = await adminRestaurant<{ url: string }>("/images", { method: "POST", body });
      if (!safeImageUrl(result.url)) throw new RestaurantAPIError("image_invalid", 400);
      patchItem(itemId, { imageUrl: result.url });
    } catch (error) { reportError(error instanceof RestaurantAPIError ? error.code : "server_error"); }
    finally { setUploading(false); }
  }
  return <div className="ra-menu-grid">
    <section className="ra-card ra-categories">
      <div className="ra-section-title"><h2>{t("admin.categories")}</h2><button type="button" className="ra-icon-button" aria-label={t("admin.addCategory")} onClick={() => update(current => ({ ...current, categories: [...current.categories, { id: crypto.randomUUID(), name: "", sort: current.categories.length }] }))}><Plus size={18} /></button></div>
      {catalog.categories.map(category => <div className="ra-category" key={category.id}>
        <Field label={t("admin.name")}><input value={category.name} required maxLength={120} onChange={event => update(current => ({ ...current, categories: current.categories.map(entry => entry.id === category.id ? { ...entry, name: event.target.value } : entry) }))} /></Field>
        <div className="ra-row"><Field label={t("admin.sort")}><input type="number" min={0} max={10000} step={1} value={category.sort} onChange={event => update(current => ({ ...current, categories: current.categories.map(entry => entry.id === category.id ? { ...entry, sort: Number(event.target.value) } : entry) }))} /></Field>
          <button type="button" className="ra-icon-button ra-danger" aria-label={`${t("common.remove")}: ${category.name}`} onClick={() => {
            if (catalog.items.some(entry => entry.categoryId === category.id)) { reportError("admin.categoryInUse"); return; }
            if (window.confirm(t("admin.removeConfirm"))) update(current => ({ ...current, categories: current.categories.filter(entry => entry.id !== category.id) }));
          }}><Trash2 size={18} /></button></div>
      </div>)}
    </section>
    <section className="ra-card ra-dishes">
      <div className="ra-section-title"><h2>{t("admin.items")}</h2><button type="button" className="ra-icon-button" aria-label={t("admin.addItem")} disabled={!catalog.categories.length} onClick={addItem}><Plus size={18} /></button></div>
      <Field label={t("store.search")}><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
      <div className="ra-item-list">{catalog.items.filter(entry => `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(entry => <button key={entry.id} type="button" aria-pressed={selected === entry.id} className={`ra-item-pick ${selected === entry.id ? "ra-selected" : ""}`} onClick={() => select(entry.id)}>
        <span>{entry.name || t("admin.addItem")}<small>{catalog.categories.find(category => category.id === entry.categoryId)?.name}</small></span><strong>{money(entry.priceMinor, catalog.settings.currency)}</strong>
        {!entry.available && <small>{t("store.unavailable")}</small>}
      </button>)}</div>
      {!catalog.items.length && <p className="ra-empty">{t("admin.noItems")}</p>}
      <button type="button" className="ra-secondary" disabled={!catalog.categories.length} onClick={addItem}><Plus size={16} />{t("admin.addItem")}</button>
    </section>
    {item && <section className="ra-card ra-item-editor" key={item.id}>
      <div className="ra-section-title"><h2>{item.name || t("admin.addItem")}</h2><button type="button" className="ra-icon-button ra-danger" aria-label={t("common.remove")} onClick={() => {
        if (window.confirm(t("admin.removeConfirm"))) { update(current => ({ ...current, items: current.items.filter(entry => entry.id !== item.id) })); select(catalog.items.find(entry => entry.id !== item.id)?.id ?? ""); }
      }}><Trash2 size={18} /></button></div>
      <div className="ra-form-grid">
        <Field label={t("admin.name")}><input required maxLength={160} value={item.name} onChange={event => patchItem(item.id, { name: event.target.value })} /></Field>
        <Field label={t("admin.category")}><select value={item.categoryId} required onChange={event => patchItem(item.id, { categoryId: event.target.value })}>{catalog.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
        <MoneyInput value={item.priceMinor} currency={catalog.settings.currency} label={t("admin.price")} onChange={priceMinor => patchItem(item.id, { priceMinor })} />
        <Field label={t("admin.sort")}><input type="number" min={0} max={10000} step={1} value={item.sort} onChange={event => patchItem(item.id, { sort: Number(event.target.value) })} /></Field>
      </div>
      <Field label={t("admin.description")}><textarea value={item.description} maxLength={2000} rows={3} onChange={event => patchItem(item.id, { description: event.target.value })} /></Field>
      <Check label={t("admin.available")} checked={item.available} onChange={available => patchItem(item.id, { available })} />
      <p className="ra-muted">{t("adminStock.menuHint")}</p>{onOpenStock && <button type="button" className="ra-secondary ra-spaced" onClick={onOpenStock}>{t("adminStock.edit")}</button>}
      <div className="ra-image-editor">
        {item.imageUrl && safeImageUrl(item.imageUrl) && <img src={item.imageUrl} alt={item.name} loading="lazy" referrerPolicy="no-referrer" />}
        <div><Field label={t("admin.imageUrl")} hint={t("admin.imageHint")}><input value={item.imageUrl} dir="ltr" maxLength={2048} aria-invalid={!safeImageUrl(item.imageUrl)} onChange={event => patchItem(item.id, { imageUrl: event.target.value })} /></Field>
          <button type="button" className="ra-upload" onClick={() => document.getElementById(uploadID)?.click()}><Upload size={16} />{t("admin.uploadImage")}</button><input hidden id={uploadID} type="file" accept="image/jpeg,image/png" onChange={event => { void upload(event.target.files?.[0], item.id); event.target.value = ""; }} /></div>
      </div>
      <div className="ra-section-title"><h3>{t("admin.options")}</h3><button type="button" className="ra-secondary" onClick={() => patchItem(item.id, { options: [...item.options, { id: crypto.randomUUID(), name: "", priceMinor: 0, available: true }] })}><Plus size={16} />{t("admin.addOption")}</button></div>
      <p className="ra-muted">{t("admin.optionPriceHint")}</p>
      {item.options.map(option => <div className="ra-option" key={option.id}>
        <Field label={t("admin.name")}><input required maxLength={120} value={option.name} onChange={event => patchItem(item.id, { options: item.options.map(entry => entry.id === option.id ? { ...entry, name: event.target.value } : entry) })} /></Field>
        <MoneyInput value={option.priceMinor} currency={catalog.settings.currency} label={t("admin.price")} onChange={priceMinor => patchItem(item.id, { options: item.options.map(entry => entry.id === option.id ? { ...entry, priceMinor } : entry) })} />
        <Check label={t("admin.available")} checked={option.available} onChange={available => patchItem(item.id, { options: item.options.map(entry => entry.id === option.id ? { ...entry, available } : entry) })} />
        <button type="button" className="ra-icon-button ra-danger" aria-label={`${t("common.remove")}: ${option.name}`} onClick={() => patchItem(item.id, { options: item.options.filter(entry => entry.id !== option.id) })}><Trash2 size={18} /></button>
      </div>)}
    </section>}
  </div>;
}
