package main

import (
	"context"
	"reflect"
	"testing"
)

func TestRestaurantAccountAddressCountries(t *testing.T) {
	for _, country := range []string{"", "ZZ", "USA", "US", "TR", "AE", " gb "} {
		_, err := cleanRestaurantAccountAddress(restaurantAddress{Country: country, AddressLine: "a valid address"})
		restaurantAccountsRequireError(t, err, "country_required")
	}
	_, err := cleanRestaurantAccountAddress(restaurantAddress{Country: "SA"})
	restaurantAccountsRequireError(t, err, "address_required")
	saudi, err := cleanRestaurantAccountAddress(restaurantAddress{Country: " sa ", NationalAddress: "ABCD1234", AdditionalNumber: "1234"})
	if err != nil || saudi.Country != "SA" || saudi.NationalAddress != "ABCD1234" || saudi.AdditionalNumber != "1234" {
		t.Fatal("Saudi address fields not preserved")
	}
	legacy := restaurantNormalizeLegacyAddress(restaurantAddress{NationalAddress: "ABCD1234"})
	if legacy.Country != "SA" || legacy.NationalAddress != "ABCD1234" {
		t.Fatal("legacy Saudi address no longer usable")
	}
	foreign := restaurantAddress{Country: "TR", AddressLine: "a historical address", NationalAddress: "ABCD1234", AdditionalNumber: "1234"}
	if got := restaurantNormalizeLegacyAddress(foreign); !reflect.DeepEqual(got, foreign) {
		t.Fatal("read compatibility changed a historical foreign address")
	}
}

func TestRestaurantAccountsCountryPersistenceAndLegacyRead(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	accounts, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	customer, token, err := accounts.Register(ctx, "country_test", "test-only-password", "Country test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = accounts.Update(ctx, customer.ID, restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: " sa ", NationalAddress: "ABCD1234", AdditionalNumber: "1234"}}})
	if err != nil {
		t.Fatal(err)
	}
	var country, national, additional string
	if err = db.QueryRowContext(ctx, `SELECT addresses->0->>'country',addresses->0->>'nationalAddress',addresses->0->>'additionalNumber' FROM restaurant_customers WHERE id=$1`, customer.ID).Scan(&country, &national, &additional); err != nil {
		t.Fatal(err)
	}
	if country != "SA" || national != "ABCD1234" || additional != "1234" {
		t.Fatal("Saudi address did not persist normalized country and national fields")
	}
	_, err = accounts.Update(ctx, customer.ID, restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: "TR", AddressLine: "a foreign address"}}})
	restaurantAccountsRequireError(t, err, "country_required")
	loaded, ok, err := accounts.Authenticate(ctx, token)
	if err != nil || !ok || len(loaded.Addresses) != 1 || loaded.Addresses[0].Country != "SA" || loaded.Addresses[0].NationalAddress != "ABCD1234" {
		t.Fatal("rejected foreign update changed the saved Saudi address")
	}
	const historicalForeign = `[{"country":"TR","addressLine":"a historical address","nationalAddress":"ABCD1234","additionalNumber":"1234"}]`
	_, err = db.ExecContext(ctx, `UPDATE restaurant_customers SET addresses=$2::jsonb WHERE id=$1`, customer.ID, historicalForeign)
	if err != nil {
		t.Fatal(err)
	}
	loaded, ok, err = accounts.Authenticate(ctx, token)
	if err != nil || !ok || len(loaded.Addresses) != 1 || loaded.Addresses[0].Country != "TR" || loaded.Addresses[0].NationalAddress != "ABCD1234" || loaded.Addresses[0].AdditionalNumber != "1234" {
		t.Fatal("reading a historical foreign address altered its fields")
	}
	var unchanged bool
	if err = db.QueryRowContext(ctx, `SELECT addresses=$2::jsonb FROM restaurant_customers WHERE id=$1`, customer.ID, historicalForeign).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("authentication mutated the stored historical foreign address")
	}
	_, err = db.ExecContext(ctx, `UPDATE restaurant_customers SET addresses='[{"nationalAddress":"ABCD1234","additionalNumber":"1234"}]'::jsonb WHERE id=$1`, customer.ID)
	if err != nil {
		t.Fatal(err)
	}
	loaded, ok, err = accounts.Authenticate(ctx, token)
	if err != nil || !ok || len(loaded.Addresses) != 1 || loaded.Addresses[0].Country != "SA" || loaded.Addresses[0].NationalAddress != "ABCD1234" {
		t.Fatal("legacy address did not normalize safely")
	}
	var storedCountry bool
	if err = db.QueryRowContext(ctx, `SELECT addresses->0 ? 'country' FROM restaurant_customers WHERE id=$1`, customer.ID).Scan(&storedCountry); err != nil {
		t.Fatal(err)
	}
	if storedCountry {
		t.Fatal("authentication unexpectedly mutated stored legacy address")
	}
}
