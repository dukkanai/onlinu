package main

// Restaurants and new delivery addresses currently support Saudi Arabia only.
// Keep this write-time policy aligned with client/src/restaurant/countries.ts;
// it must not be used to relabel historical addresses when loading them.
const restaurantCountryCodes = "SA"

func restaurantSupportedCountry(code string) bool {
	return code == restaurantCountryCodes
}

// Country was absent before the restaurant operations update. Normalize only
// that missing legacy value; do not turn another country into Saudi Arabia.
func restaurantNormalizeLegacyAddress(address restaurantAddress) restaurantAddress {
	if address.Country == "" {
		address.Country = "SA"
	}
	// Explicit historical foreign addresses remain exactly as recorded, including
	// any legacy fields. Rejecting new foreign writes must not rewrite old data.
	return address
}

func restaurantStripSaudiAddressFields(address restaurantAddress) restaurantAddress {
	if address.Country != "SA" {
		address.NationalAddress = ""
		address.AdditionalNumber = ""
	}
	return address
}
