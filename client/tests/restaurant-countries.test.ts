import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isHistoricalRestaurantCountry, restaurantCountries, restaurantCountryName } from "../src/restaurant/countries";

test("Saudi Arabia is the only allowed country and matches the server allowlist", () => {
  assert.deepEqual(restaurantCountries, ["SA"]);
  const source = readFileSync(new URL("../../cmd/server/restaurant_country.go", import.meta.url), "utf8");
  const match = source.match(/const restaurantCountryCodes = "([A-Z ]+)"/);
  assert.ok(match);
  assert.deepEqual(restaurantCountries, match[1].split(" "));
  for (const code of restaurantCountries) assert.match(code, /^[A-Z]{2}$/);
});

test("historical country recognition is separate from new delivery support", () => {
  assert.equal(isHistoricalRestaurantCountry("AE"), true);
  assert.equal(isHistoricalRestaurantCountry("TR"), true);
  assert.equal(isHistoricalRestaurantCountry("ZZ"), false);
  assert.equal(restaurantCountries.includes("AE"), false);
});

test("region names use every supported interface language without translating menu content", () => {
  for (const locale of ["ar", "en"]) {
    assert.notEqual(restaurantCountryName("SA", locale), "SA", `${locale}: missing localized country data`);
    assert.notEqual(restaurantCountryName("AF", locale), "AF", `${locale}: missing localized country data`);
  }
  assert.equal(restaurantCountryName("ZZ", "ar"), "ZZ");
  for (const removed of ["fr", "ur", "zz", "invalid_locale"]) {
    assert.equal(restaurantCountryName("SA", removed), restaurantCountryName("SA", "ar"), "removed interface languages use the Arabic fallback");
  }
});
