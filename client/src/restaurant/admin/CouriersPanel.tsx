import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus, RefreshCw, Save, Truck } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Courier } from "../types";
import { Check, Field } from "./Fields";

interface CourierDraft { username: string; name: string; phone: string; password: string; active: boolean }
const emptyCourier = (): CourierDraft => ({ username: "", name: "", phone: "", password: "", active: true });

export function CouriersPanel() {
  const { t } = useLocale();
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [selected, setSelected] = useState<Courier | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CourierDraft>(emptyCourier);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try { const response = await adminRestaurant<{ couriers: Courier[] }>("/couriers", { signal }); if (!signal?.aborted) { setCouriers(response.couriers ?? []); setError(""); } }
    catch (problem) { if (!signal?.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  function edit(courier: Courier | null) { setSelected(courier); setDraft(courier ? { username: courier.username, name: courier.name, phone: courier.phone, password: "", active: courier.active } : emptyCourier()); setEditing(true); setNotice(false); setError(""); }
  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setNotice(false);
    const payload = { name: draft.name.trim(), phone: draft.phone.trim(), active: draft.active, ...(!selected ? { username: draft.username.trim() } : {}), ...(draft.password ? { password: draft.password } : {}) };
    try {
      await adminRestaurant<{ courier: Courier }>(selected ? `/couriers/${encodeURIComponent(selected.id)}` : "/couriers", { method: selected ? "PATCH" : "POST", body: JSON.stringify(payload) });
      setDraft(emptyCourier()); setSelected(null); setEditing(false); setNotice(true); await load();
    } catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { setBusy(false); }
  }
  return <section><div className="ra-section-title"><p className="ra-muted">{t("adminNext.courierHint")}</p><div className="ra-row"><button className="ra-secondary" type="button" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} />{t("common.refresh")}</button><button className="ra-primary" type="button" disabled={busy} onClick={() => edit(null)}><Plus size={16} />{t("adminNext.addCourier")}</button></div></div>
    <a className="ra-secondary" href="/courier" target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />{t("adminNext.courierLogin")}</a>
    {error && <p className="ra-alert ra-spaced" role="alert">{t(`errors.${error}`)}</p>}{notice && <p className="ra-notice ra-spaced" role="status">{t("adminNext.courierSaved")}</p>}
    <div className="ra-couriers-layout ra-spaced"><div className="ra-courier-list">{loading && !couriers.length && <p role="status">{t("common.loading")}</p>}{!loading && !couriers.length && <div className="ra-card ra-empty"><Truck size={35} /><p>{t("adminNext.noCouriers")}</p></div>}
      {couriers.map(courier => <button key={courier.id} type="button" className={`ra-card ra-courier-pick ${selected?.id === courier.id ? "ra-selected" : ""}`} aria-pressed={selected?.id === courier.id} onClick={() => edit(courier)} disabled={busy}><div><strong>{courier.name}</strong><span className={`ra-status ${courier.active && courier.availability === "available" ? "ra-status-completed" : ""}`}>{t(`courier.availability.${courier.availability}`)}</span></div><p dir="ltr">{courier.username}</p><small>{t(courier.active ? "adminNext.courierActive" : "store.unavailable")}</small></button>)}
    </div>{editing && <form className="ra-card" onSubmit={event => { event.preventDefault(); void save(); }}><h2>{selected?.name || t("adminNext.addCourier")}</h2><fieldset disabled={busy} className="ra-editor-fields ra-spaced">
      <Field label={t("account.username")} hint={t("account.usernameHint")}><input dir="ltr" value={draft.username} required minLength={3} maxLength={40} readOnly={Boolean(selected)} autoComplete="off" onChange={event => setDraft(current => ({ ...current, username: event.target.value }))} /></Field>
      <Field label={t("admin.name")}><input required value={draft.name} maxLength={100} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></Field>
      <Field label={t("order.phone")}><input type="tel" dir="ltr" value={draft.phone} maxLength={40} onChange={event => setDraft(current => ({ ...current, phone: event.target.value }))} /></Field>
      <Field label={t(selected ? "adminNext.resetPassword" : "account.password")} hint={t(selected ? "adminNext.passwordHint" : "account.passwordHint")}><input type="password" value={draft.password} required={!selected} minLength={10} maxLength={128} autoComplete="new-password" onChange={event => setDraft(current => ({ ...current, password: event.target.value }))} /></Field>
      <Check label={t("adminNext.courierActive")} checked={draft.active} onChange={active => setDraft(current => ({ ...current, active }))} />
      <div className="ra-row"><button className="ra-primary" type="submit"><Save size={16} />{t(busy ? "common.loading" : "common.save")}</button><button className="ra-secondary" type="button" onClick={() => { setDraft(emptyCourier()); setEditing(false); setSelected(null); }}>{t("common.cancel")}</button></div>
    </fieldset></form>}</div>
  </section>;
}
