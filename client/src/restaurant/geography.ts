import { useEffect, useState } from "react";
import { adminRestaurant, RestaurantAPIError, storefront } from "./api";
import type { Address, Locale, Settings } from "./types";

export interface GeographyRegion { id: string; nameAr: string; nameEn: string }
export interface GeographyCity extends GeographyRegion { regionId: string }
export interface GeographyDistrict extends GeographyCity { cityId: string; custom: boolean }
export interface GeographyResult {
  version: number;
  source: { name: string; revision: string; license: string; notice: string };
  regions: GeographyRegion[]; cities: GeographyCity[]; districts: GeographyDistrict[];
}
export interface GeographyDistrictInput { version: number; id?: string; cityId: string; nameAr: string; nameEn: string }
export interface GeographyDistrictSaved { version: number; district: GeographyDistrict }
export type GeographyKind = "regions" | "cities" | "districts";
export type DeliveryZone = NonNullable<Settings["deliveryZones"]>[number];

export const geographyName = (entry: Pick<GeographyRegion,"nameAr"|"nameEn">, locale: Locale): string => locale === "ar" ? entry.nameAr || entry.nameEn : entry.nameEn || entry.nameAr;
export const districtPricing = (settings?: Settings): boolean => settings?.deliveryPricingMode === "district";
export function deliveryZoneFee(settings: Settings | undefined, districtId: string | undefined): number | null {
  const zone = settings?.deliveryZones?.find(entry => entry.districtId === districtId);
  return zone?.enabled && zone.feeMinor !== null && Number.isSafeInteger(zone.feeMinor) && zone.feeMinor >= 0 && zone.feeMinor <= 100000000 ? zone.feeMinor : null;
}
export function validDeliveryZones(settings: Pick<Settings,"deliveryPricingMode"|"deliveryZones">): boolean {
  if (settings.deliveryPricingMode !== undefined && !["flat","district"].includes(settings.deliveryPricingMode)) return false;
  const zones=settings.deliveryZones??[];
  if (!Array.isArray(zones) || zones.length > 10000 || zones.some(zone => !zone || typeof zone !== "object") || new Set(zones.map(zone=>zone.districtId)).size !== zones.length) return false;
  return zones.every(zone=>typeof zone.districtId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(zone.districtId) && typeof zone.enabled === "boolean" && (zone.feeMinor === null ? !zone.enabled : Number.isSafeInteger(zone.feeMinor)&&zone.feeMinor>=0&&zone.feeMinor<=100000000));
}
export function updateDeliveryZone(zones: DeliveryZone[], districtId: string, patch: Partial<Pick<DeliveryZone,"enabled"|"feeMinor">>): DeliveryZone[] {
  const previous=zones.find(zone=>zone.districtId===districtId)??{districtId,enabled:false,feeMinor:null};
  return [...zones.filter(zone=>zone.districtId!==districtId),{...previous,...patch}];
}
export function clearDestinationDetails(address: Address): Address {
  return {...address, country:"SA", street:"",building:"",postalCode:"",additionalNumber:"",nationalAddress:"",addressLine:"",area:"",latitude:null,longitude:null};
}
export function addressWithRegion(address: Address, regionId: string): Address {
  return address.regionId===regionId ? address : {...clearDestinationDetails(address),regionId,cityId:"",districtId:"",city:"",district:""};
}
export function addressWithCity(address: Address, city?: GeographyCity): Address {
  if (city && address.cityId===city.id && address.regionId===city.regionId) return address;
  return {...clearDestinationDetails(address),regionId:city?.regionId??address.regionId??"",cityId:city?.id??"",districtId:"",city:city?.nameAr??"",district:""};
}
export function addressWithDistrict(address: Address, district?: GeographyDistrict): Address {
  if (district && address.districtId===district.id && address.cityId===district.cityId && address.regionId===district.regionId) return address;
  return {...clearDestinationDetails(address),regionId:district?.regionId??address.regionId??"",cityId:district?.cityId??address.cityId??"",districtId:district?.id??"",district:district?.nameAr??"",area:district?.nameAr??""};
}
export function destinationKey(address: Address): string {
  return JSON.stringify([address.country || "SA", address.regionId || "", address.cityId || "", address.districtId || "", address.city, address.district, address.area]);
}
export function geographyPath(kind: GeographyKind, parentId = "", coverageOnly = false): string | null {
  if (kind !== "regions" && !parentId) return null;
  return `/geography?kind=${kind}${kind==="cities"?`&regionId=${encodeURIComponent(parentId)}`:kind==="districts"?`&cityId=${encodeURIComponent(parentId)}`:""}${coverageOnly?"&coverage=available":""}`;
}

// Bind responses to their full query. Switching city never temporarily exposes
// a previous city's districts, and old requests cannot overwrite the new list.
export function useGeography(kind: GeographyKind, parentId = "", options: {admin?:boolean;coverageOnly?:boolean;refresh?:number;enabled?:boolean} = {}) {
  const path=options.enabled === false ? null : geographyPath(kind,parentId,options.coverageOnly), admin=!!options.admin;
  const [state,setState]=useState<{path:string|null;admin:boolean;data?:GeographyResult;loading:boolean;error:string}>({path:null,admin,data:undefined,loading:!!path,error:""});
  useEffect(()=>{
    if (!path) {setState({path,admin,loading:false,error:""});return;}
    const controller=new AbortController();
    setState({path,admin,loading:true,error:""});
    void (admin?adminRestaurant:storefront)<GeographyResult>(path,{signal:controller.signal}).then(data=>{
      if(!controller.signal.aborted)setState({path,admin,data,loading:false,error:""});
    }).catch(error=>{if(!controller.signal.aborted)setState({path,admin,loading:false,error:error instanceof RestaurantAPIError?error.code:"geography_unavailable"});});
    return()=>controller.abort();
  },[path,admin,options.refresh]);
  return state.path===path&&state.admin===admin?state:{path,admin,loading:!!path,error:"",data:undefined};
}
