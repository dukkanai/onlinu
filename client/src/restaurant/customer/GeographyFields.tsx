import { useId, useState } from "react";
import { useLocale } from "../i18n";
import { addressWithCity, addressWithDistrict, addressWithRegion, clearDestinationDetails, deliveryZoneFee, districtPricing, geographyName, useGeography } from "../geography";
import type { Address, Settings } from "../types";

export function GeographyFields({ value, onChange, settings, coverageOnly = false }: {
  value: Address; onChange: (address: Address) => void; settings?: Settings; coverageOnly?: boolean;
}) {
  const { t, locale, money } = useLocale();
  const id = useId();
  const required = districtPricing(settings) && coverageOnly;
  const [chooseDirectory, setChooseDirectory] = useState(false);
  const directory = required || chooseDirectory || !!(value.regionId || value.cityId || value.districtId);
  const [refresh, setRefresh] = useState(0);
  const options = { coverageOnly: required && coverageOnly, refresh, enabled: directory };
  const regions = useGeography("regions", "", options);
  const cities = useGeography("cities", value.regionId, options);
  const districts = useGeography("districts", value.cityId, options);
  const loading = regions.loading || cities.loading || districts.loading;
  const unavailable = !!(regions.error || cities.error || districts.error);
  const fee = deliveryZoneFee(settings, value.districtId);
  const staleDistrict = !!value.districtId && !districts.loading && !!districts.data && !districts.data.districts.some(district => district.id === value.districtId);
  const noCoverage = !unavailable && !loading && (regions.data?.regions.length === 0 || (!!value.regionId && cities.data?.cities.length === 0) || (!!value.cityId && districts.data?.districts.length === 0));
  return <>
    {!required && <div className="rs-field-wide"><button type="button" className="rs-link-button" onClick={() => {
      setChooseDirectory(!directory);
      if (directory) onChange({ ...clearDestinationDetails(value), regionId: "", cityId: "", districtId: "" });
    }}>{t(directory ? "deliveryGeo.manual" : "deliveryGeo.chooseDirectory")}</button></div>}
    {directory ? <>
      <div className="rs-field-wide"><p className="rs-muted">{t("deliveryGeo.community")}</p></div>
      <label className="rs-field" htmlFor={`${id}-region`}><span id={`${id}-region-label`}>{t("deliveryGeo.region")}</span><select id={`${id}-region`} aria-labelledby={`${id}-region-label`} value={value.regionId ?? ""} required disabled={regions.loading} onChange={event => onChange(addressWithRegion(value, event.target.value))}>
        <option value="">{t(regions.loading ? "common.loading" : "deliveryGeo.selectRegion")}</option>
        {value.regionId && !regions.data?.regions.some(region => region.id === value.regionId) && <option value={value.regionId} disabled>{t("deliveryGeo.selectRegion")}</option>}
        {regions.data?.regions.map(region => <option value={region.id} key={region.id}>{geographyName(region, locale)}</option>)}
      </select></label>
      <label className="rs-field" htmlFor={`${id}-city`}><span id={`${id}-city-label`}>{t("address.city")}</span><select id={`${id}-city`} aria-labelledby={`${id}-city-label`} value={value.cityId ?? ""} required disabled={!value.regionId || cities.loading} onChange={event => onChange(addressWithCity(value, cities.data?.cities.find(city => city.id === event.target.value)))}>
        <option value="">{t(cities.loading ? "common.loading" : "deliveryGeo.selectCity")}</option>
        {value.cityId && !cities.data?.cities.some(city => city.id === value.cityId) && <option value={value.cityId} disabled>{value.city || t("deliveryGeo.selectCity")}</option>}
        {cities.data?.cities.map(city => <option value={city.id} key={city.id}>{geographyName(city, locale)}</option>)}
      </select></label>
      <label className="rs-field" htmlFor={`${id}-district`}><span id={`${id}-district-label`}>{t("address.district")}</span><select id={`${id}-district`} aria-labelledby={`${id}-district-label`} value={value.districtId ?? ""} required disabled={!value.cityId || districts.loading} aria-invalid={staleDistrict || undefined} onChange={event => onChange(addressWithDistrict(value, districts.data?.districts.find(district => district.id === event.target.value)))}>
        <option value="">{t(districts.loading ? "common.loading" : "deliveryGeo.selectDistrict")}</option>
        {value.districtId && !districts.data?.districts.some(district => district.id === value.districtId) && <option value={value.districtId} disabled>{value.district || t("deliveryGeo.selectDistrict")}</option>}
        {districts.data?.districts.map(district => <option value={district.id} key={district.id}>{geographyName(district, locale)}</option>)}
      </select></label>
      {unavailable && <div className="rs-field-wide rs-notice rs-notice-error" role="alert"><span>{t("deliveryGeo.unavailable")}</span><button type="button" className="rs-link-button" onClick={() => setRefresh(old => old + 1)}>{t("common.retry")}</button></div>}
      {noCoverage && <p className="rs-field-wide rs-muted" role="status">{t("deliveryGeo.noCoverage")}</p>}
      {(staleDistrict || required && coverageOnly && value.districtId && fee === null) && <p className="rs-field-wide rs-notice rs-notice-error" role="alert">{t("deliveryGeo.notServed")}</p>}
      {required && coverageOnly && fee !== null && settings && <p className="rs-field-wide rs-muted" role="status">{t("deliveryGeo.fee", { amount: money(fee, settings.currency) })} {t("deliveryGeo.reviewFee")}</p>}
      <small className="rs-field-wide rs-muted">{t("deliveryGeo.selectionHint")}</small>
    </> : (["city", "district"] as const).map(key => <label className="rs-field" key={key} htmlFor={`${id}-${key}`}><span>{t(`address.${key}`)}</span><input id={`${id}-${key}`} maxLength={120} value={value[key]} autoComplete={key === "city" ? "address-level2" : "address-level3"} onChange={event => onChange({ ...value, [key]: event.target.value, latitude: null, longitude: null })} /></label>)}
  </>;
}
