import { useEffect, useId, useState } from "react";
import { ImagePlus, Palette, RotateCcw, Save, Upload, RefreshCw } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Catalog } from "../types";
import { brandColorKeys, brandContrastIssues, brandTemplate, contrastText, effectiveBrand, isBrandColor, restaurantFonts, storefrontTemplate, storefrontTemplates, type Brand, type BrandState } from "../brand";
import { BrandPreview } from "../BrandPreview";
import { Field } from "./Fields";
import { safeImageUrl } from "./helpers";
import "../brand.css";
import "./brand-editor.css";

export function BrandEditor({ catalog, onPublished, reportError, setUploading, onDirtyChange }: {
  catalog: Catalog; onPublished: () => void; reportError: (code: string) => void;
  setUploading?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useLocale();
  const prefix = useId();
  const [state, setState] = useState<BrandState | null>(null);
  const [brand, setBrand] = useState<Brand>(() => effectiveBrand(catalog.settings));
  const [busy, setBusy] = useState(false), [advanced, setAdvanced] = useState(false), [mobile, setMobile] = useState(true);
  const [message, setMessage] = useState("");
  const dirty = state !== null && JSON.stringify(brand) !== JSON.stringify(state.draft ?? state.live);
  const valid = brandColorKeys.every(key => isBrandColor(brand[key])) && [brand.logoUrl, brand.coverUrl, brand.introImageUrl].every(safeImageUrl) && brandContrastIssues(brand).length === 0;
  const contrastIssues = brandContrastIssues(brand);
  const patch = (change: Partial<Brand>) => { setMessage(""); setBrand(previous => ({ ...previous, ...change })); };
  const fail = (error: unknown) => reportError(error instanceof RestaurantAPIError ? error.code : "server_error");
  function receive(next: BrandState) { setState(next); setBrand(next.draft ?? next.live); }
  useEffect(() => { let active = true; adminRestaurant<BrandState>("/brand").then(next => { if (active) receive(next); }).catch(error => { if (active) fail(error); }); return () => { active = false; }; }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => { onDirtyChange?.(false); }; }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  async function action(kind: "draft" | "publish" | "revert") {
    if (!state || busy || kind === "draft" && !valid || kind === "publish" && (!state.draft || dirty) || kind === "revert" && dirty) return;
    if (kind === "revert" && !window.confirm(t("brand.revertConfirm"))) return;
    setBusy(true); setMessage("");
    try {
      const next = await adminRestaurant<BrandState>(`/brand/${kind}`, { method: kind === "draft" ? "PUT" : "POST", body: JSON.stringify({ version: state.version, ...(kind === "draft" ? { brand } : {}) }) });
      receive(next); setMessage(t(kind === "draft" ? "brand.draftSaved" : kind === "publish" ? "brand.published" : "brand.reverted"));
      if (kind !== "draft") onPublished();
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (busy || dirty && !window.confirm(t("admin.discardConfirm"))) return;
    setBusy(true); setMessage("");
    try { receive(await adminRestaurant<BrandState>("/brand")); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  }
  async function upload(file: File | undefined, key: "logoUrl" | "coverUrl" | "introImageUrl") {
    if (!file || busy) return;
    if (file.size > 5 * 1024 * 1024) { reportError("image_too_large"); return; }
    if (!["image/jpeg", "image/png"].includes(file.type)) { reportError("image_invalid"); return; }
    setBusy(true); setUploading?.(true);
    try { const body = new FormData(); body.append("image", file); const result = await adminRestaurant<{ url: string }>("/images", { method: "POST", body }); if (!safeImageUrl(result.url)) throw new RestaurantAPIError("image_invalid", 400); patch({ [key]: result.url }); }
    catch (error) { fail(error); }
    finally { setBusy(false); setUploading?.(false); }
  }
  const layoutLabel = (value: string) => `brand.layout${value[0].toUpperCase()}${value.slice(1)}`;
  return <div className="ra-brand-workspace">
    <div className="ra-brand-status"><p>{t("brand.draftHint")}</p><div className="ra-row">
      <button type="button" className="ra-secondary" disabled={busy || !state || !valid || !dirty && !!state.draft} onClick={() => void action("draft")}><Save size={16} />{t("brand.saveDraft")}</button>
      <button type="button" className="ra-primary" disabled={busy || !state?.draft || dirty} onClick={() => void action("publish")}><Upload size={16} />{t("brand.publish")}</button>
      <button type="button" className="ra-secondary" disabled={busy || !state?.hasPrevious || dirty} onClick={() => void action("revert")}><RotateCcw size={16} />{t("brand.revert")}</button>
      <button type="button" className="ra-secondary" disabled={busy} onClick={() => void reload()}><RefreshCw size={16} />{t("common.refresh")}</button>
    </div>{message && <p role="status">{message}</p>}{dirty && <p>{t("brand.unsaved")}</p>}</div>
    <div className="ra-brand-layout"><section className="ra-card"><div className="ra-section-title"><h2>{t("adminNext.brand")}</h2><Palette size={20} /></div>
      <fieldset disabled={busy || !state} className="ra-brand-fields">
        <Field label={t("brand.storefrontTemplate")} hint={t(`${layoutLabel(storefrontTemplate(brand))}Hint`)}><select value={storefrontTemplate(brand)} onChange={event => patch({ storefrontTemplate: event.target.value as Brand["storefrontTemplate"] })}>{storefrontTemplates.map(value => <option key={value} value={value}>{t(layoutLabel(value))}</option>)}</select></Field>
        <Field label={t("brand.colorPreset")}><select value={brand.template} onChange={event => { setBrand(current => brandTemplate(current, event.target.value as Brand["template"])); setMessage(""); }}>{(["classic", "warm", "modern"] as const).map(value => <option key={value} value={value}>{t(`brand.${value}`)}</option>)}</select></Field>
        <fieldset className="ra-font-fields"><legend>{t("brand.typography")}</legend>{(["headingFont", "bodyFont", "buttonFont"] as const).map(key => <Field key={key} label={t(`brand.${key}`)}><select value={brand[key] || ""} onChange={event => patch({ [key]: event.target.value || undefined })}><option value="">{t("brand.inheritFont")}</option>{restaurantFonts.map(font => <option key={font} value={font}>{t(`brand.${font}`)}</option>)}</select></Field>)}</fieldset>
        <div className="ra-color-control"><Field label={t("brand.primaryColor")}><input dir="ltr" value={brand.primaryColor} pattern="#[a-fA-F0-9]{6}" maxLength={7} onChange={event => patch({ primaryColor: event.target.value, ...(isBrandColor(event.target.value) ? { primaryTextColor: contrastText(event.target.value) } : {}) })} /></Field><input aria-label={`${t("brand.primaryColor")} (${t("adminNext.preview")})`} type="color" value={isBrandColor(brand.primaryColor) ? brand.primaryColor : "#214e40"} onChange={event => patch({ primaryColor: event.target.value, primaryTextColor: contrastText(event.target.value) })} /></div>
        {(["logoUrl", "coverUrl", "introImageUrl"] as const).map(key => <div className="ra-brand-image" key={key}><Field label={t(key === "logoUrl" ? "adminNext.logo" : key === "coverUrl" ? "adminNext.cover" : "brand.introImage")} hint={t("admin.imageHint")}><input value={brand[key]} dir="ltr" maxLength={2048} aria-invalid={!safeImageUrl(brand[key])} onChange={event => patch({ [key]: event.target.value })} /></Field>
          <button className="ra-upload" type="button" onClick={() => document.getElementById(`${prefix}-${key}`)?.click()}><ImagePlus size={17} />{t("admin.uploadImage")}</button><input hidden id={`${prefix}-${key}`} type="file" accept="image/jpeg,image/png" onChange={event => { void upload(event.target.files?.[0], key); event.target.value = ""; }} /></div>)}
        <Field label={t("brand.introTitle")}><input value={brand.introTitle} maxLength={160} onChange={event => patch({ introTitle: event.target.value })} /></Field>
        <Field label={t("brand.introText")}><textarea rows={4} value={brand.introText} maxLength={2000} onChange={event => patch({ introText: event.target.value })} /></Field>
        <label className="ra-brand-check"><input type="checkbox" checked={brand.hideHero} onChange={event => patch({ hideHero: event.target.checked })} />{t("brand.hideHero")}</label>
        <button type="button" className="ra-secondary ra-spaced" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{t("brand.advanced")}</button>
        {advanced && <div className="ra-brand-advanced"><div className="ra-color-fields">{brandColorKeys.filter(key => key !== "primaryColor").map(key => <div className="ra-color-control" key={key}><Field label={t(`brand.${key}`)}><input dir="ltr" value={brand[key]} pattern="#[a-fA-F0-9]{6}" maxLength={7} aria-invalid={!isBrandColor(brand[key])} onChange={event => patch({ [key]: event.target.value })} /></Field><input aria-label={`${t(`brand.${key}`)} (${t("adminNext.preview")})`} type="color" value={isBrandColor(brand[key]) ? brand[key] : "#000000"} onChange={event => patch({ [key]: event.target.value })} /></div>)}</div>
          {([ ["radius", ["square", "soft", "round"]], ["shadow", ["none", "soft"]], ["font", ["system", "serif"]], ["imageFit", ["cover", "contain"]], ["textSize", ["normal", "large"]], ["layout", ["grid", "list"]] ] as const).map(([key, values]) => <Field key={key} label={t(`brand.${key}`)}><select value={brand[key]} onChange={event => patch({ [key]: event.target.value })}>{values.map(value => <option key={value} value={value}>{t(`brand.${value}`)}</option>)}</select></Field>)}
        </div>}
      </fieldset>
      {contrastIssues.length > 0 ? <div className="ra-warning" role="alert"><strong>{t("brand.contrastFailed")}</strong><ul>{contrastIssues.map(([a, b]) => <li key={`${a}-${b}`}>{t(`brand.${a}`)} / {t(`brand.${b}`)}</li>)}</ul></div> : <p className="ra-muted ra-spaced">{t("brand.contrastPassed")}</p>}
    </section>
    <section className="ra-card ra-brand-preview-panel"><div className="ra-section-title"><h2>{t("adminNext.preview")}</h2><div className="ra-row"><button type="button" className="ra-secondary" aria-pressed={mobile} onClick={() => setMobile(true)}>{t("brand.mobile")}</button><button type="button" className="ra-secondary" aria-pressed={!mobile} onClick={() => setMobile(false)}>{t("brand.desktop")}</button></div></div>
      <BrandPreview catalog={catalog} brand={brand} mobile={mobile} /><p className="ra-muted ra-preview-note">{t("brand.previewHint")}</p>
    </section></div>
  </div>;
}
