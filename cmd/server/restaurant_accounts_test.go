package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func restaurantAccountsRequireError(t *testing.T, err error, code string) {
	t.Helper()
	var public *restaurantError
	if !errors.As(err, &public) || public.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestRestaurantAccountsPasswordValidation(t *testing.T) {
	tests := []struct {
		name, password string
		valid          bool
	}{
		{"empty", "", false},
		{"short", "123456789", false},
		{"minimum", "1234567890", true},
		{"spaces only", strings.Repeat(" ", 12), false},
		{"long", strings.Repeat("x", 129), false},
		{"limit", strings.Repeat("x", 128), true},
		{"unicode", strings.Repeat("س", 10), true},
		{"unicode bytes are not characters", strings.Repeat("س", 5), false},
		{"over bcrypt byte limit", strings.Repeat("界", 128), true},
		{"control", "a secure\npassword", false},
		{"invalid unicode", "securepassword\xff", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := restaurantAccountPasswordValid(test.password); got != test.valid {
				t.Fatalf("valid=%v, want %v", got, test.valid)
			}
		})
	}
	// The last characters must still matter when passwords exceed bcrypt's
	// native 72-byte limit, including when all characters are multilingual.
	left := restaurantPasswordInput(strings.Repeat("界", 100) + "a")
	right := restaurantPasswordInput(strings.Repeat("界", 100) + "b")
	if string(left) == string(right) || len(left) > 72 {
		t.Fatal("password prehash must preserve all characters within bcrypt limit")
	}
}

func TestRestaurantAccountsUsernameValidation(t *testing.T) {
	for _, value := range []string{"guest", "  GUEST  ", "مستخدم", "हिन्दी", "a.user-name_1", "Cafe\u0301"} {
		if _, err := restaurantAccountUsername(value); err != nil {
			t.Errorf("valid username %q: %v", value, err)
		}
	}
	for _, value := range []string{"", "ab", "has space", "name@example.com", "user\nname", "user\x00", strings.Repeat("x", 41), "bad\xff"} {
		_, err := restaurantAccountUsername(value)
		restaurantAccountsRequireError(t, err, "invalid_username")
	}
	for _, pair := range [][2]string{{"  GUEST  ", "guest"}, {"Cafe\u0301", "café"}, {"Straße", "STRASSE"}} {
		left, _ := restaurantAccountUsername(pair[0])
		right, _ := restaurantAccountUsername(pair[1])
		if left != right {
			t.Errorf("expected case/normalization-equivalent usernames, got %q and %q", left, right)
		}
	}
}

func TestRestaurantAccountsProfileValidation(t *testing.T) {
	lat, lon := 24.7136, 46.6753
	profile, err := validateRestaurantCustomerUpdate(restaurantCustomerUpdate{
		DisplayName: "  عميل المطعم  ", Phone: "+966 50 123 4567",
		Addresses: []restaurantAddress{{Country: "SA", Label: "المنزل", NationalAddress: "ABCD1234", Latitude: &lat, Longitude: &lon}},
	})
	if err != nil || profile.DisplayName != "عميل المطعم" || len(profile.Addresses) != 1 || len(profile.Addresses[0].ID) != 32 {
		t.Fatalf("unexpected valid profile: %+v %v", profile, err)
	}
	lat = 0
	if *profile.Addresses[0].Latitude != 24.7136 {
		t.Fatal("validated profile retains caller-owned coordinate pointer")
	}
	empty, err := validateRestaurantCustomerUpdate(restaurantCustomerUpdate{})
	if err != nil || empty.Addresses == nil {
		t.Fatal("optional profile must allow empty fields and encode addresses as []")
	}
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Addresses: make([]restaurantAddress, 6)})
	restaurantAccountsRequireError(t, err, "too_many_addresses")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{DisplayName: strings.Repeat("ع", 101)})
	restaurantAccountsRequireError(t, err, "invalid_request")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Phone: "not a phone"})
	restaurantAccountsRequireError(t, err, "invalid_request")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: "SA", Label: "only a label"}}})
	restaurantAccountsRequireError(t, err, "address_required")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: "SA", ID: "same", AddressLine: "address one"}, {Country: "SA", ID: "same", AddressLine: "address two"}}})
	restaurantAccountsRequireError(t, err, "invalid_request")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: "SA", AddressLine: strings.Repeat("a", 501)}}})
	restaurantAccountsRequireError(t, err, "invalid_request")
	_, err = validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Addresses: []restaurantAddress{{Country: "SA", AddressLine: "bad\x00address"}}})
	restaurantAccountsRequireError(t, err, "invalid_request")
}

func TestRestaurantAccountsCoordinateValidation(t *testing.T) {
	for _, test := range []struct {
		name string
		lat  *float64
		lon  *float64
	}{
		{"only latitude", restaurantAccountTestFloat(20), nil},
		{"only longitude", nil, restaurantAccountTestFloat(20)},
		{"latitude NaN", restaurantAccountTestFloat(math.NaN()), restaurantAccountTestFloat(20)},
		{"longitude infinity", restaurantAccountTestFloat(20), restaurantAccountTestFloat(math.Inf(1))},
		{"latitude range", restaurantAccountTestFloat(-91), restaurantAccountTestFloat(20)},
		{"longitude range", restaurantAccountTestFloat(20), restaurantAccountTestFloat(181)},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := cleanRestaurantAccountAddress(restaurantAddress{Country: "SA", AddressLine: "address", Latitude: test.lat, Longitude: test.lon})
			restaurantAccountsRequireError(t, err, "invalid_request")
		})
	}
	for _, pair := range [][2]float64{{-90, -180}, {0, 0}, {90, 180}} {
		if _, err := cleanRestaurantAccountAddress(restaurantAddress{Country: "SA", AddressLine: "complete address", Latitude: &pair[0], Longitude: &pair[1]}); err != nil {
			t.Errorf("valid coordinate boundary rejected: %v", err)
		}
	}
}

func TestRestaurantProfileAndCheckoutValidationAlign(t *testing.T) {
	address := restaurantAddress{
		Country: "SA",
		ID:      strings.Repeat("i", 128), Label: strings.Repeat("l", 100),
		City: strings.Repeat("c", 120), District: strings.Repeat("d", 120), Street: strings.Repeat("s", 200),
		Building: strings.Repeat("b", 40), PostalCode: strings.Repeat("p", 30), AdditionalNumber: strings.Repeat("a", 30),
		NationalAddress: strings.Repeat("n", 300), AddressLine: strings.Repeat("r", 500), Area: strings.Repeat("a", 120),
	}
	profile, err := validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Phone: "+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧", Addresses: []restaurantAddress{address}})
	if err != nil {
		t.Fatal(err)
	}
	if profile.Phone != "+966 50 123 4567" || !restaurantOrderPhone(profile.Phone) {
		t.Fatal("saved phone must be normalized and accepted at checkout")
	}
	if err := restaurantValidateDelivery(restaurantSettings{}, profile.Addresses[0]); err != nil {
		t.Fatalf("profile accepted a maximum-length address that checkout rejects: %v", err)
	}
	for _, address := range []restaurantAddress{
		{Country: "SA", AddressLine: "one"}, {Country: "SA", NationalAddress: "ABCD"},
		{Country: "SA", Latitude: restaurantAccountTestFloat(24), Longitude: restaurantAccountTestFloat(46)},
	} {
		_, err := cleanRestaurantAccountAddress(address)
		restaurantAccountsRequireError(t, err, "address_required")
	}
	for _, phone := range []string{"123", strings.Repeat("1", 16), "+--()"} {
		_, err := validateRestaurantCustomerUpdate(restaurantCustomerUpdate{Phone: phone})
		restaurantAccountsRequireError(t, err, "invalid_request")
	}
}

func restaurantAccountTestFloat(value float64) *float64 { return &value }

func TestRestaurantAccountsPasswordWorkBound(t *testing.T) {
	first, err := restaurantPasswordSlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	second, err := restaurantPasswordSlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer second()
	_, err = restaurantPasswordSlot(context.Background())
	restaurantAccountsRequireError(t, err, "rate_limited")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := restaurantPasswordSlot(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled hash request should not acquire slot: %v", err)
	}
}

func TestRestaurantAccountsMalformedTokens(t *testing.T) {
	accounts := &restaurantAccounts{}
	for _, token := range []string{"", "short", strings.Repeat("a", 42), strings.Repeat("a", 44), strings.Repeat("!", 43), strings.Repeat("a", 43), strings.Repeat("x", 100000)} {
		// A canonical 43-character token is valid structurally even when random;
		// this particular repeated-a form has nonzero trailing padding bits.
		if _, valid := restaurantCustomerTokenDigest(token); valid {
			t.Fatalf("malformed token accepted: length %d", len(token))
		}
		if _, ok, err := accounts.Authenticate(context.Background(), token); ok || err != nil {
			t.Fatalf("malformed token should not need a database: ok=%v err=%v", ok, err)
		}
		if err := accounts.Logout(context.Background(), token); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRestaurantAccountsIntegrationLifecycleAndIsolation(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	accounts, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	password := strings.Repeat("界", 100) + "one"
	alice, token, err := accounts.Register(ctx, "  Alice  ", password, "أليس")
	if err != nil || alice.Username != "alice" || alice.DisplayName != "أليس" || alice.Addresses == nil {
		t.Fatalf("register: %+v %v", alice, err)
	}
	bob, bobToken, err := accounts.Register(ctx, "bob", "different password", "Bob")
	if err != nil {
		t.Fatal(err)
	}
	if alice.ID == bob.ID || token == bobToken {
		t.Fatal("different customers must receive independent identities and sessions")
	}
	var hash string
	if err := db.QueryRowContext(ctx, `SELECT password_hash FROM restaurant_customers WHERE id = $1`, alice.ID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, restaurantPasswordHashPrefix) || strings.Contains(hash, password) {
		t.Fatal("password must only be stored as a versioned salted hash")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(strings.TrimPrefix(hash, restaurantPasswordHashPrefix)), restaurantPasswordInput(password)); err != nil {
		t.Fatal("stored password hash cannot verify exact full Unicode password")
	}
	digest := sha256.Sum256([]byte(token))
	var storedHash []byte
	var ttlSeconds float64
	if err := db.QueryRowContext(ctx, `SELECT token_hash, extract(epoch FROM expires_at-created_at) FROM restaurant_customer_sessions WHERE customer_id = $1`, alice.ID).Scan(&storedHash, &ttlSeconds); err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(storedHash) != hex.EncodeToString(digest[:]) || len(storedHash) != 32 || ttlSeconds != restaurantCustomerSessionLifetime.Seconds() {
		t.Fatal("session must store only SHA256 with seven-day lifetime")
	}
	_, _, err = accounts.Register(ctx, "ALICE", "another password", "")
	restaurantAccountsRequireError(t, err, "username_taken")
	for _, input := range [][2]string{{"notfound", password}, {"alice", strings.Repeat("界", 100) + "two"}, {"alice", "short"}, {"invalid user", password}} {
		_, _, err := accounts.Login(ctx, input[0], input[1])
		restaurantAccountsRequireError(t, err, "invalid_credentials")
	}
	loggedIn, secondToken, err := accounts.Login(ctx, "ALICE", password)
	if err != nil || loggedIn.ID != alice.ID || secondToken == token {
		t.Fatalf("login should issue a fresh session for canonical username: %v", err)
	}
	updated, err := accounts.Update(ctx, alice.ID, restaurantCustomerUpdate{DisplayName: "اسم جديد", Phone: "+966 50 123 4567", Addresses: []restaurantAddress{{Country: "SA", NationalAddress: "ABCD1234", Label: "Home"}}})
	if err != nil || len(updated.Addresses) != 1 || updated.Addresses[0].ID == "" {
		t.Fatalf("profile update: %+v %v", updated, err)
	}
	for _, validToken := range []string{token, secondToken} {
		customer, ok, err := accounts.Authenticate(ctx, validToken)
		if err != nil || !ok || customer.ID != alice.ID || customer.DisplayName != "اسم جديد" || len(customer.Addresses) != 1 {
			t.Fatalf("session should read current own profile: %+v %v %v", customer, ok, err)
		}
	}
	other, ok, err := accounts.Authenticate(ctx, bobToken)
	if err != nil || !ok || other.ID != bob.ID || other.Phone != "" || len(other.Addresses) != 0 {
		t.Fatal("Alice's profile must not affect Bob")
	}
	if err := accounts.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := accounts.Authenticate(ctx, token); err != nil || ok {
		t.Fatal("revoked session still authenticates")
	}
	if _, ok, err := accounts.Authenticate(ctx, secondToken); err != nil || !ok {
		t.Fatal("logout must not revoke other sessions")
	}
	secondDigest := sha256.Sum256([]byte(secondToken))
	if _, err := db.ExecContext(ctx, `UPDATE restaurant_customer_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, secondDigest[:]); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := accounts.Authenticate(ctx, secondToken); err != nil || ok {
		t.Fatal("expired session still authenticates")
	}
	if _, ok, err := accounts.Authenticate(ctx, bobToken); err != nil || !ok {
		t.Fatal("expiry must not affect a different customer")
	}
	_, err = accounts.Update(ctx, "nonexistent", restaurantCustomerUpdate{})
	restaurantAccountsRequireError(t, err, "unauthorized")
	if err := accounts.Logout(ctx, token); err != nil {
		t.Fatal("repeated logout must remain idempotent")
	}
	// Constructing a second store represents a process restart: durable
	// customer sessions remain usable, with no in-memory token registry.
	restarted, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok, err := restarted.Authenticate(ctx, bobToken); err != nil || !ok || got.ID != bob.ID {
		t.Fatal("valid session did not survive store reinitialization")
	}
}

func TestRestaurantAccountsIntegrationSessionLimit(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	accounts, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	customer, oldest, err := accounts.Register(ctx, "session-limit", "a strong passphrase", "")
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the transactional session-creation path directly to avoid
	// repeatedly spending production bcrypt cost on this database-bound test.
	var latest string
	for i := 0; i < restaurantCustomerMaxSessions+2; i++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		var lockedID string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM restaurant_customers WHERE id = $1 FOR UPDATE`, customer.ID).Scan(&lockedID); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		latest, err = accounts.createSession(ctx, tx, customer.ID)
		if err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_customer_sessions WHERE customer_id = $1`, customer.ID).Scan(&count); err != nil || count != restaurantCustomerMaxSessions {
		t.Fatalf("session cap should be %d, got %d: %v", restaurantCustomerMaxSessions, count, err)
	}
	if _, ok, err := accounts.Authenticate(ctx, oldest); err != nil || ok {
		t.Fatal("oldest session should be revoked when session cap is reached")
	}
	if _, ok, err := accounts.Authenticate(ctx, latest); err != nil || !ok {
		t.Fatal("latest session should authenticate")
	}
	if _, err := db.ExecContext(ctx, `UPDATE restaurant_customer_sessions SET expires_at = $2 WHERE customer_id = $1`, customer.ID, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, _, err = accounts.Login(ctx, customer.Username, "a strong passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_customer_sessions WHERE customer_id = $1`, customer.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("sign-in should clean expired sessions, count=%d: %v", count, err)
	}
}
