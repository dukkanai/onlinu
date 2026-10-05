import { useEffect, useRef, useState } from "react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { currencyMinorDigits, useLocale } from "../i18n";
import { districtPricing, geographyName, updateDeliveryZone, useGeography, type GeographyDistrict, type GeographyDistrictInput, type GeographyDistrictSaved } from "../geography";
import type { DeliveryZone, Settings } from "../types";
import { Check, Field } from "./Fields";
import { formatMinorInput, parseMinor } from "./helpers";
import "./delivery-zones.css";

function DistrictFee({ zone, currency, onChange }: { zone: DeliveryZone; currency: string; onChange: (fee: number | null) => void }) {
  const { t } = useLocale();
  const digits = currencyMinorDigits(currency);
  const [text, setText] = useState(zone.feeMinor === null ? "" : formatMinorInput(zone.feeMinor, digits));
  const emitted = useRef({ value: zone.feeMinor, digits });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (emitted.current.value !== zone.feeMinor || emitted.current.digits !== digits) {
      emitted.current = { value: zone.feeMinor, digits };
      setText(zone.feeMinor === null ? "" : formatMinorInput(zone.feeMinor, digits));
      input.current?.setCustomValidity("");
    }
  }, [zone.feeMinor, digits]);
  return <Field label={t("deliveryZones.fee")} hint={t("admin.priceHint", { currency })}><input ref={input} type="text" dir="ltr" inputMode="decimal" value={text} required={zone.enabled} onChange={event => {
    const raw = event.target.value;
    const value = raw.trim() ? parseMinor(raw, digits) : null;
    setText(raw);
    event.target.setCustomValidity(raw.trim() && value === null ? t("admin.validation") : "");
    emitted.current = { value, digits };
    onChange(value);
  }} /></Field>;
}

export function DeliveryZonesEditor({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { t, locale, money } = useLocale();
  const [regionId, setRegionId] = useState("");
  const [cityId, setCityId] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(30);
  const [configuredSearch, setConfiguredSearch] = useState("");
  const [configuredLimit, setConfiguredLimit] = useState(30);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<GeographyDistrictInput | null>(null);
  const [saving, setSaving] = useState(false);
  const mutation = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const regions = useGeography("regions", "", { admin: true, refresh });
  const cities = useGeography("cities", regionId, { admin: true, refresh });
  const districts = useGeography("districts", cityId, { admin: true, refresh });
  const zones = settings.deliveryZones ?? [];
  const rows = (districts.data?.districts ?? []).filter(district => `${district.nameAr} ${district.nameEn}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  // The active directory deliberately omits retired districts and ancestors.
  // Keep stored entries reachable by ID so they can always be disabled without
  // discarding their fee or blocking unrelated catalog changes. Re-enabling is
  // available only through the active directory above and server validation.
  const configuredRows = zones.filter(zone => zone.districtId.toLocaleLowerCase().includes(configuredSearch.trim().toLocaleLowerCase()));
  const busy = regions.loading || cities.loading || districts.loading;
  const loadError = regions.error || cities.error || districts.error;
  const patchZone = (id: string, patch: Partial<Pick<DeliveryZone, "enabled" | "feeMinor">>) => onChange({ deliveryZones: updateDeliveryZone(zones, id, patch) });
  const edit = (district?: GeographyDistrict) => {
    if (!districts.data || !cityId) return;
    setError(""); setNotice("");
    setEditing({ version: districts.data.version, cityId, id: district?.id, nameAr: district?.nameAr ?? "", nameEn: district?.nameEn ?? "" });
  };
  const saveDistrict = async () => {
    if (!editing || mutation.current) return;
    if (!editing.nameAr.trim()) { setError("invalid_geography"); return; }
    mutation.current = true; setSaving(true); setError(""); setNotice("");
    try {
      await adminRestaurant<GeographyDistrictSaved>("/geography/district", { method: "PUT", body: JSON.stringify(editing) });
      setEditing(null); setRefresh(old => old + 1); setNotice("deliveryZones.savedDistrict");
    } catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { mutation.current = false; setSaving(false); }
  };
  return <section className="ra-card ra-delivery-zones">
    <h2>{t("deliveryZones.title")}</h2>
    <Field label={t("deliveryZones.mode")}><select value={settings.deliveryPricingMode ?? "flat"} onChange={event => onChange({ deliveryPricingMode: event.target.value as "flat" | "district" })}>
      <option value="flat">{t("deliveryZones.flat")}</option><option value="district">{t("deliveryZones.district")}</option>
    </select></Field>
    <p className="ra-muted">{t(districtPricing(settings) ? "deliveryZones.districtHint" : "deliveryZones.flatHint")}</p>
    <p className="ra-muted">{t("deliveryZones.publishHint")}</p>
    <details open={districtPricing(settings)}><summary>{t("deliveryZones.title")}</summary>
      <p className="ra-muted">{t("deliveryZones.directoryHint")}</p>
      <p className="ra-muted">{t("deliveryZones.count", { count: zones.filter(zone => zone.enabled && zone.feeMinor !== null && Number.isSafeInteger(zone.feeMinor) && zone.feeMinor >= 0).length })}</p>
      <fieldset disabled={saving} className="ra-editor-fields">
        <div className="ra-form-grid">
          <Field label={t("deliveryGeo.region")}><select value={regionId} disabled={regions.loading} onChange={event => { setRegionId(event.target.value); setCityId(""); setSearch(""); setLimit(30); setEditing(null); setError(""); setNotice(""); }}>
            <option value="">{t(regions.loading ? "common.loading" : "deliveryGeo.selectRegion")}</option>{regions.data?.regions.map(region => <option key={region.id} value={region.id}>{geographyName(region, locale)}</option>)}
          </select></Field>
          <Field label={t("address.city")}><select value={cityId} disabled={!regionId || cities.loading} onChange={event => { setCityId(event.target.value); setSearch(""); setLimit(30); setEditing(null); setError(""); setNotice(""); }}>
            <option value="">{t(cities.loading ? "common.loading" : "deliveryGeo.selectCity")}</option>{cities.data?.cities.map(city => <option key={city.id} value={city.id}>{geographyName(city, locale)}</option>)}
          </select></Field>
        </div>
        {loadError && <div className="ra-alert" role="alert"><span>{t("deliveryGeo.unavailable")}</span><button type="button" onClick={() => setRefresh(old => old + 1)}>{t("common.retry")}</button></div>}
        {!cityId && <p className="ra-muted">{t("deliveryZones.selectCity")}</p>}
        {cityId && <>
          <Field label={t("deliveryZones.search")}><input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(30); }} /></Field>
          {busy && <p role="status">{t("common.loading")}</p>}
          {!busy && !loadError && rows.length === 0 && <p className="ra-muted">{t("deliveryZones.none")}</p>}
          <div className="ra-zone-list">{rows.slice(0, limit).map(district => {
            const zone = zones.find(entry => entry.districtId === district.id) ?? { districtId: district.id, enabled: false, feeMinor: null };
            return <div className="ra-zone-row" key={district.id}>
              <div className="ra-zone-heading"><strong>{geographyName(district, locale)}</strong>{district.custom && <small>{t("deliveryZones.local")}</small>}</div>
              <Check label={t("deliveryZones.enabled")} checked={zone.enabled} onChange={enabled => patchZone(district.id, { enabled })} />
              <DistrictFee zone={zone} currency={settings.currency} onChange={feeMinor => patchZone(district.id, { feeMinor })} />
              {zone.feeMinor === null ? <small className={zone.enabled ? "ra-warning" : "ra-muted"}>{t("deliveryZones.unset")}</small> : zone.feeMinor === 0 && <small className="ra-muted">{t("deliveryZones.free")}</small>}
              <div className="ra-row"><button type="button" className="ra-secondary" onClick={() => patchZone(district.id, { feeMinor: 0 })}>{t("deliveryZones.freeAction")}</button><button type="button" className="ra-secondary" onClick={() => edit(district)}>{t("deliveryZones.correct")}</button></div>
            </div>;
          })}</div>
          {rows.length > limit && <button type="button" className="ra-secondary" onClick={() => setLimit(old => old + 30)}>{t("deliveryZones.more")}</button>}
          <button type="button" className="ra-secondary" disabled={!districts.data || busy} onClick={() => edit()}>{t("deliveryZones.add")}</button>
        </>}
        {zones.length > 0 && <details className="ra-configured-zones">
          <summary>{t("deliveryZones.configuredTitle")} ({zones.length})</summary>
          <p className="ra-muted">{t("deliveryZones.configuredHint")}</p>
          <Field label={t("deliveryZones.configuredSearch")}><input type="search" dir="ltr" value={configuredSearch} onChange={event => { setConfiguredSearch(event.target.value); setConfiguredLimit(30); }} /></Field>
          <div className="ra-zone-list">{configuredRows.slice(0, configuredLimit).map(zone => <div className="ra-configured-zone" key={zone.districtId}>
            <code dir="ltr">{zone.districtId}</code>
            <span>{zone.feeMinor === null ? t("deliveryZones.unset") : `${t("deliveryZones.fee")}: ${money(zone.feeMinor, settings.currency)}`}</span>
            {zone.enabled ? <button type="button" className="ra-secondary" onClick={() => patchZone(zone.districtId, { enabled: false })}>{t("deliveryZones.disable")}</button> : <small className="ra-muted">{t("deliveryZones.disabled")}</small>}
          </div>)}</div>
          {configuredRows.length > configuredLimit && <button type="button" className="ra-secondary" onClick={() => setConfiguredLimit(old => old + 30)}>{t("deliveryZones.more")}</button>}
        </details>}
        {editing && <section className="ra-zone-correction" aria-label={t("deliveryZones.correctionTitle")} onKeyDown={event => {
          // This editor is inside the catalog form; Enter must save this
          // directory correction, not unexpectedly publish catalog changes.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); if (error !== "geography_changed") void saveDistrict(); }
        }}>
          <h3>{t("deliveryZones.correctionTitle")}</h3><p className="ra-muted">{t("deliveryZones.overlayHint")}</p>
          <Field label={t("deliveryZones.nameAr")}><input dir="rtl" lang="ar" maxLength={120} value={editing.nameAr} onChange={event => setEditing({ ...editing, nameAr: event.target.value })} /></Field>
          <Field label={t("deliveryZones.nameEn")}><input dir="ltr" lang="en" maxLength={120} value={editing.nameEn} onChange={event => setEditing({ ...editing, nameEn: event.target.value })} /></Field>
          <div className="ra-row"><button type="button" className="ra-primary" disabled={saving || !editing.nameAr.trim() || error === "geography_changed"} onClick={() => void saveDistrict()}>{t(saving ? "common.loading" : "deliveryZones.saveDistrict")}</button><button type="button" className="ra-secondary" onClick={() => { setEditing(null); setError(""); }}>{t("common.cancel")}</button></div>
        </section>}
        {error && <div className="ra-alert" role="alert"><span>{t(error === "geography_changed" ? "deliveryZones.conflict" : `errors.${error}`)}</span>{error === "geography_changed" && <button type="button" onClick={() => { setEditing(null); setError(""); setRefresh(old => old + 1); }}>{t("admin.reload")}</button>}</div>}
        {notice && <div className="ra-notice" role="status">{t(notice)}</div>}
      </fieldset>
    </details>
  </section>;
}
