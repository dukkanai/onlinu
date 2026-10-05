// New restaurant settings and delivery addresses support Saudi Arabia only.
// Kept in sync with restaurant_country.go; UI language is independent of country.
export const restaurantCountries: readonly string[] = ["SA"];

// Historical addresses still need their original labels, and an in-flight order
// must retain its exact retry identity after the supported country list changes.
const historicalCountryCodes: readonly string[] = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");

export function isHistoricalRestaurantCountry(country: string): boolean {
  return historicalCountryCodes.includes(country);
}

const displayNames = new Map<string, Intl.DisplayNames>();

export function restaurantCountryName(country: string, locale: string): string {
  if (!isHistoricalRestaurantCountry(country)) return country;
  const supportedLocale = locale === "en" ? "en" : "ar";
  try {
    let names = displayNames.get(supportedLocale);
    if (!names) {
      // Do not silently substitute English on older devices without this
      // locale's CLDR region data; the unambiguous ISO code is the fallback.
      if (!Intl.DisplayNames.supportedLocalesOf([supportedLocale]).length) return country;
      names = new Intl.DisplayNames([supportedLocale], { type: "region", fallback: "code" });
      displayNames.set(supportedLocale, names);
    }
    return names.of(country) ?? country;
  } catch {
    return country;
  }
}
