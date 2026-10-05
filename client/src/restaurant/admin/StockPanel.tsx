import { useCallback, useEffect, useState } from "react";
import { Package, RefreshCw, Save } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { MenuItem, StockItem } from "../types";
import { Check, Field } from "./Fields";

export function stockUpdatePayload(stock: StockItem, tracked: boolean, available: number) {
  if (!Number.isSafeInteger(available) || available < 0 || available > 1000000) return null;
  return { tracked, available: tracked ? available : 0, version: stock.version };
}

export function StockPanel({ items }: { items: MenuItem[] }) {
  const { t, date } = useLocale();
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<StockItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(false);
  const stock = stocks.find(entry => entry.itemId === selected);
  const dirty = draft && (draft.tracked !== (stock?.tracked ?? false) || draft.available !== (stock?.available ?? 0));
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const result = await adminRestaurant<{ items: StockItem[] }>("/stock", { signal }); if (!signal?.aborted) setStocks(result.items ?? []); }
    catch (problem) { if (!signal?.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { setDraft(selected ? { ...(stock ?? { itemId: selected, tracked: false, available: 0, held: 0, version: 0, updatedAt: "" }) } : null); }, [selected, stock]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function save() {
    if (busy || loading || !draft) return;
    const body = stockUpdatePayload(draft, draft.tracked, draft.available);
    if (!body) { setError("invalid_request"); return; }
    setBusy(true); setError(""); setNotice(false);
    try {
      const value = await adminRestaurant<StockItem>(`/stock/${encodeURIComponent(draft.itemId)}`, { method: "PUT", body: JSON.stringify(body) });
      setStocks(current => [...current.filter(entry => entry.itemId !== value.itemId), value]); setNotice(true);
    } catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { setBusy(false); }
  }
  const confirmDiscard = () => !dirty || window.confirm(t("admin.discardConfirm"));
  return <section><div className="ra-section-title"><p className="ra-muted">{t("adminStock.hint")}</p><button type="button" className="ra-secondary" disabled={busy || loading} onClick={() => { if (confirmDiscard()) void load(); }}><RefreshCw size={16} />{t("common.refresh")}</button></div>
    {error && <p className="ra-alert" role="alert">{t(error === "conflict" ? "adminStock.conflict" : `errors.${error}`)}</p>}{notice && <p className="ra-notice" role="status">{t("adminStock.saved")}</p>}
    <div className="ra-stock-layout"><section className="ra-card"><Field label={t("store.search")}><input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></Field>
      {loading && <p role="status">{t("common.loading")}</p>}<div className="ra-stock-list">{items.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => {
        const current = stocks.find(entry => entry.itemId === item.id);
        return <button type="button" key={item.id} className={`ra-item-pick ${selected === item.id ? "ra-selected" : ""}`} disabled={busy} aria-pressed={selected === item.id} onClick={() => { if (confirmDiscard()) { setSelected(item.id); setNotice(false); setError(""); } }}><span><strong>{item.name}</strong><small>{current?.tracked ? `${t("adminStock.available")}: ${current.available} · ${t("adminStock.held")}: ${current.held}` : t("adminStock.untracked")}</small></span>{!item.available && <small>{t("store.unavailable")}</small>}</button>;
      })}</div>{!items.length && <p>{t("admin.noItems")}</p>}</section>
      {draft && items.some(item => item.id === selected) ? <form className="ra-card" onSubmit={event => { event.preventDefault(); void save(); }}><h2><Package size={18} /> {items.find(item => item.id === selected)?.name}</h2><fieldset className="ra-editor-fields ra-spaced" disabled={busy || loading}>
        <Check label={t("adminStock.tracked")} checked={draft.tracked} onChange={tracked => setDraft(current => current ? { ...current, tracked, available: tracked ? current.available : 0 } : null)} />
        <Field label={t("adminStock.available")} hint={t("adminStock.hint")}><input type="number" dir="ltr" min={0} max={1000000} step={1} required disabled={!draft.tracked} value={draft.available} onChange={event => setDraft(current => current ? { ...current, available: Number(event.target.value) } : null)} /></Field>
        <p>{t("adminStock.held")}: <strong>{draft.held}</strong></p>{draft.updatedAt && <p className="ra-muted"><time dateTime={draft.updatedAt}>{date(draft.updatedAt)}</time></p>}
        <button type="submit" className="ra-primary ra-spaced" disabled={!dirty}><Save size={16} />{t(busy ? "common.loading" : "common.save")}</button>
      </fieldset></form> : <p className="ra-card ra-empty">{t("adminStock.select")}</p>}
    </div>
  </section>;
}
