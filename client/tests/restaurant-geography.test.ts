import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../src/restaurant/i18n";
import { GeographyFields } from "../src/restaurant/customer/GeographyFields";
import { addressWithCity, addressWithDistrict, addressWithRegion, deliveryZoneFee, destinationKey, geographyPath, updateDeliveryZone, validDeliveryZones } from "../src/restaurant/geography";
import { emptyAddress, type Address, type Settings } from "../src/restaurant/types";

const address: Address = { ...emptyAddress(), id: "saved-1", label: "Home", regionId: "sa-r-1", cityId: "sa-c-1", districtId: "sa-d-1", city: "الرياض", district: "الملقا", area: "الملقا", street: "Old street", building: "22", postalCode: "12345", additionalNumber: "1234", nationalAddress: "ABCD1234", addressLine: "Old entrance", latitude: 24.7, longitude: 46.7 };
const fields = (value: Address, settings: Partial<Settings>, coverageOnly: boolean) => renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: "en", children: createElement(GeographyFields, { value, settings: settings as Settings, coverageOnly, onChange: () => {} }) }));

test("moving a saved destination clears child selections, details and old map location", () => {
  const moved = addressWithRegion(address, "sa-r-2");
  assert.equal(moved.regionId, "sa-r-2");
  for (const key of ["cityId", "districtId", "city", "district", "area", "street", "building", "postalCode", "additionalNumber", "nationalAddress", "addressLine"] as const) assert.equal(moved[key], "", key);
  assert.equal(moved.latitude, null); assert.equal(moved.longitude, null);
  assert.equal(moved.id, "saved-1"); assert.equal(moved.label, "Home");
  assert.equal(address.street, "Old street", "never mutate the stored address");
  assert.equal(addressWithRegion(address, "sa-r-1"), address);
  const city = addressWithCity(address, { id: "sa-c-2", regionId: "sa-r-1", nameAr: "الدرعية", nameEn: "Diriyah" });
  assert.equal(city.city, "الدرعية"); assert.equal(city.districtId, ""); assert.equal(city.latitude, null);
  const district = addressWithDistrict(address, { id: "sa-d-2", cityId: "sa-c-1", regionId: "sa-r-1", nameAr: "النخيل", nameEn: "An Nakheel", custom: false });
  assert.equal(district.district, "النخيل"); assert.equal(district.area, "النخيل"); assert.equal(district.city, "الرياض"); assert.equal(district.nationalAddress, "");
  assert.notEqual(destinationKey(address), destinationKey(district), "a late location callback must not update a different destination");
});

test("delivery coverage distinguishes unset, disabled and explicit free fees", () => {
  const config: Partial<Settings> = { deliveryPricingMode: "district", deliveryZones: [{ districtId: "paid", enabled: true, feeMinor: 1500 }, { districtId: "free", enabled: true, feeMinor: 0 }, { districtId: "disabled", enabled: false, feeMinor: 0 }, { districtId: "unset", enabled: true, feeMinor: null }] };
  assert.equal(deliveryZoneFee(config as Settings, "paid"), 1500);
  assert.equal(deliveryZoneFee(config as Settings, "free"), 0);
  for (const id of ["disabled", "unset", "unknown", undefined]) assert.equal(deliveryZoneFee(config as Settings, id), null);
  assert.equal(validDeliveryZones(config), false);
  config.deliveryZones = config.deliveryZones!.filter(zone => zone.districtId !== "unset");
  assert.equal(validDeliveryZones(config), true);
  const next = updateDeliveryZone(config.deliveryZones, "unset", { enabled: false, feeMinor: null });
  assert.equal(validDeliveryZones({ deliveryZones: next }), true);
  assert.equal(config.deliveryZones.length, 3);
  assert.equal(validDeliveryZones({ deliveryZones: [...next, next[0]] }), false);
  assert.equal(validDeliveryZones({ deliveryZones: [{ districtId: "bad id", enabled: true, feeMinor: 0 }] }), false);
  assert.equal(validDeliveryZones({ deliveryZones: [{ districtId: "free", enabled: true, feeMinor: 0.5 }] }), false);
  assert.equal(validDeliveryZones({}), true, "old flat catalogs remain valid");
});

test("a stored district can be disabled by ID even when absent from the active directory", () => {
  const zones = [{ districtId: "retired-district", enabled: true, feeMinor: 1250 }, { districtId: "active-district", enabled: true, feeMinor: 0 }];
  const disabled = updateDeliveryZone(zones, "retired-district", { enabled: false });
  assert.deepEqual(disabled.find(zone => zone.districtId === "retired-district"), { districtId: "retired-district", enabled: false, feeMinor: 1250 });
  assert.deepEqual(disabled.find(zone => zone.districtId === "active-district"), zones[1]);
  assert.equal(zones[0].enabled, true, "draft recovery must not mutate the saved settings");
  assert.equal(validDeliveryZones({ deliveryPricingMode: "district", deliveryZones: disabled }), true);
});

test("directory requests require their parent and keep coverage filtering explicit", () => {
  assert.equal(geographyPath("cities"), null);
  assert.equal(geographyPath("districts"), null);
  assert.equal(geographyPath("regions", "", true), "/geography?kind=regions&coverage=available");
  assert.equal(geographyPath("districts", "a&b", true), "/geography?kind=districts&cityId=a%26b&coverage=available");
});

test("flat/manual checkout and legacy saved addresses remain editable; district checkout cannot bypass directory", () => {
  const flat = fields(emptyAddress(), {}, true);
  assert.match(flat, /autoComplete="address-level2"/);
  assert.match(flat, /Choose from the address directory/);
  assert.doesNotMatch(flat, /<select/);
  const district = fields(emptyAddress(), { deliveryPricingMode: "district" }, true);
  assert.equal((district.match(/<select/g) ?? []).length, 3);
  assert.doesNotMatch(district, /Enter city and district manually|autoComplete="address-level2"/);
  assert.match(district, /aria-labelledby="[^"]+-region-label"/);
  const legacySaved = fields(emptyAddress(), { deliveryPricingMode: "district" }, false);
  assert.match(legacySaved, /autoComplete="address-level2"/, "editing a customer profile does not force migration of old saved addresses");
  const saved = fields(address, {}, false);
  assert.match(saved, /value="sa-d-1"/);
  assert.match(saved, /Enter city and district manually/);
});
