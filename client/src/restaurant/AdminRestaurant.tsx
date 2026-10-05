import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Archive, ClipboardList, CreditCard, ExternalLink, Package, Palette, Phone, QrCode, Save, Settings2, Truck, UtensilsCrossed } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "./api";
import { LanguagePicker, useLocale } from "./i18n";
import type { Catalog } from "./types";
import { MenuEditor, type CatalogUpdate } from "./admin/MenuEditor";
import { OrdersPanel } from "./admin/OrdersPanel";
import { SettingsEditor } from "./admin/SettingsEditor";
import { TablesEditor } from "./admin/TablesEditor";
import { BrandEditor } from "./admin/BrandEditor";
import { CouriersPanel } from "./admin/CouriersPanel";
import { PaymentsPanel } from "./admin/PaymentsPanel";
import { WhatsAppPanel } from "./admin/WhatsAppPanel";
import { StockPanel } from "./admin/StockPanel";
import { ArchivePanel } from "./admin/ArchivePanel";
import { validCatalog } from "./admin/helpers";
import "./admin/admin.css";

type Tab = "orders" | "menu" | "tables" | "settings" | "brand" | "payments" | "couriers" | "whatsapp" | "stock" | "archive";
const tabs = [
  { id: "orders", icon: ClipboardList, label: "admin.orders" }, { id: "menu", icon: UtensilsCrossed, label: "admin.menu" },
  { id: "tables", icon: QrCode, label: "admin.tables" }, { id: "brand", icon: Palette, label: "adminNext.brand" },
  { id: "settings", icon: Settings2, label: "admin.settings" }, { id: "payments", icon: CreditCard, label: "adminNext.payments" },
  { id: "couriers", icon: Truck, label: "adminNext.couriers" }, { id: "whatsapp", icon: Phone, label: "adminNext.whatsapp" },
  { id: "stock", icon: Package, label: "adminStock.tab" }, { id: "archive", icon: Archive, label: "archive.tab" },
] as const;

export function AdminRestaurant() {
  const { t, dir } = useLocale();
  const [tab, setTab] = useState<Tab>("orders");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [saved, setSaved] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorReset, setEditorReset] = useState(0);
  const [brandDirty, setBrandDirty] = useState(false);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const dirty = useMemo(() => Boolean(catalog && saved && JSON.stringify(catalog) !== JSON.stringify(saved)), [catalog, saved]);
  const busy = loading || saving || uploading || operationsBusy;
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const result = await adminRestaurant<Catalog>("/catalog", { signal }); if (!signal?.aborted) { setCatalog(result); setSaved(result); setNotice(""); } }
    catch (problem) { if (!signal?.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => {
    if (!dirty && !brandDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, brandDirty]);
  const update: CatalogUpdate = useCallback(transform => { setCatalog(current => current ? transform(current) : current); setNotice(""); }, []);
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => { if (operationsBusy || ((dirty || brandDirty) && !window.confirm(t("admin.discardConfirm")))) event.preventDefault(); };
  function changeTab(next: Tab) {
    if (next === tab) return;
    if (brandDirty && !window.confirm(t("admin.discardConfirm"))) return;
    if (next === "brand" && dirty) {
      if (!window.confirm(t("admin.discardConfirm"))) return;
      setCatalog(saved); setEditorReset(value => value + 1);
    }
    setBrandDirty(false); setTab(next); setNotice("");
  }
  async function save() {
    if (!catalog || busy) return;
    if (!validCatalog(catalog)) { setError("admin.validation"); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await adminRestaurant<Catalog>("/catalog", { method: "PUT", body: JSON.stringify(catalog) });
      setCatalog(result); setSaved(result); setNotice("admin.saveSuccess");
    } catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { setSaving(false); }
  }
  return <div className="ra-app" dir={dir}>
    <header className="ra-header"><a href="/" onClick={navigate} className="ra-brand"><span><UtensilsCrossed size={22} /></span><div><strong>{catalog?.settings.name || t("admin.title")}</strong><small>{t("admin.title")}</small></div></a><div className="ra-header-actions"><LanguagePicker /><a href="/" className="ra-top-link" onClick={navigate}><ExternalLink size={16} />{t("admin.storefront")}</a><a href="/admin/calls" className="ra-top-link" onClick={navigate}><Phone size={16} />{t("admin.calls")}</a></div></header>
    <div className="ra-shell"><aside className="ra-sidebar"><div className="ra-sidebar-label">{t("admin.title")}</div><nav aria-label={t("admin.title")}>{tabs.map(({ id, icon: Icon, label }) => <button type="button" key={id} aria-current={tab === id ? "page" : undefined} disabled={busy} className={tab === id ? "ra-nav-active" : ""} onClick={() => changeTab(id)}><Icon size={19} />{t(label)}</button>)}</nav><p>{t("admin.subtitle")}</p></aside>
      <main className="ra-main">
        <div className="ra-heading"><div><p className="ra-eyebrow">{t("admin.title")}</p><h1>{t(tabs.find(entry => entry.id === tab)!.label)}</h1></div>{catalog?.settings.demo && <span className="ra-demo-tag">{t("store.demo")}</span>}</div>
        {error && <div className="ra-alert" role="alert"><span>{error === "conflict" || error === "catalog_changed" ? t("admin.conflict") : t(error.startsWith("admin.") || error.startsWith("adminNext.") ? error : `errors.${error}`)}</span><button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm(t("admin.discardConfirm"))) void load(); }}>{t(error === "conflict" || error === "catalog_changed" ? "admin.reload" : "common.retry")}</button></div>}
        {notice && <div className="ra-notice" role="status">{t(notice)}</div>}
        {loading && !catalog && <div className="ra-card ra-empty" role="status">{t("common.loading")}</div>}
        {tab === "orders" ? <OrdersPanel onBusyChange={setOperationsBusy} /> : tab === "payments" ? <PaymentsPanel country={saved?.settings.country ?? "SA"} /> : tab === "couriers" ? <CouriersPanel /> : tab === "whatsapp" ? <WhatsAppPanel /> : tab === "stock" ? <StockPanel items={saved?.items ?? []} /> : tab === "archive" ? <ArchivePanel /> : tab === "brand" ? catalog && <BrandEditor catalog={catalog} onPublished={() => { setBrandDirty(false); void load(); }} onDirtyChange={setBrandDirty} reportError={setError} setUploading={setUploading} /> : catalog && <form id="restaurant-catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="ra-publish-bar"><p>{dirty ? t("admin.unsaved") : t("admin.catalogHint")}</p><div className="ra-row"><button type="button" className="ra-secondary" disabled={!dirty || busy} onClick={() => { if (window.confirm(t("admin.discardConfirm"))) { setCatalog(saved); setEditorReset(value => value + 1); setError(""); setNotice(""); } }}>{t("admin.discard")}</button><button type="submit" className="ra-primary" disabled={!dirty || busy}><Save size={16} />{t(busy ? "common.loading" : "admin.publish")}</button></div></div>
          <fieldset key={`${catalog.version}-${editorReset}`} disabled={busy} className="ra-editor-fields">
            {tab === "menu" && <MenuEditor catalog={catalog} update={update} reportError={setError} setUploading={setUploading} onOpenStock={() => changeTab("stock")} />}
            {tab === "tables" && <TablesEditor catalog={catalog} update={update} reportError={setError} />}
            {tab === "settings" && <SettingsEditor catalog={catalog} update={update} />}
          </fieldset>
        </form>}
      </main>
    </div>
  </div>;
}

export default AdminRestaurant;
