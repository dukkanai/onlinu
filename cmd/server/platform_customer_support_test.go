package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPlatformCustomerSupportOwnershipReviewAndRecovery(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	current, err := s.restaurant.GetCatalog(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := restaurantOrderFixtureCatalog()
	catalog.Version = current.Version
	for i := range catalog.Tables {
		catalog.Tables[i].Code = ""
	}
	if _, err = s.restaurant.SaveCatalog(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	if err = restaurantImportGeographyRecords(context.Background(), s.restaurant.db, restaurantGeographyFixtureRecords(), "synthetic-owned-support-geography"); err != nil {
		t.Fatal(err)
	}
	actor, other := uuid.NewString(), uuid.NewString()
	send := func(subject, method, path, key, scope string, input any) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, platformTestRequest(t, private, subject, method, path, key, scope, input, nil))
		return w
	}
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	created := send(actor, "POST", "/platform-api/orders", uuid.NewString(), "orders:write", input)
	var initial platformOrderView
	if created.Code != 200 || json.Unmarshal(created.Body.Bytes(), &initial) != nil {
		t.Fatal(created.Code, created.Body.String())
	}
	path := "/platform-api/customer-support/" + initial.Number
	key := uuid.NewString()
	command := platformCustomerSupportInput{Version: initial.Version, Reviewed: true, Reason: "Synthetic private customer explanation"}
	for _, scope := range []string{"orders:write", "staff:support:decide", "staff:support:read"} {
		if w := send(actor, "POST", path+"/cancellation", key, scope, command); w.Code != 401 {
			t.Fatalf("wrong authority %s: %d", scope, w.Code)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		target, scope, body := path, "customer:support:read", any(nil)
		if method == "POST" {
			target += "/cancellation"
			scope = "customer:support:write"
			body = command
		}
		if w := send(other, method, target, key, scope, body); w.Code != 404 {
			t.Fatalf("foreign owner %s: %d", method, w.Code)
		}
	}
	missing := command
	missing.Reviewed = false
	if w := send(actor, "POST", path+"/cancellation", key, "customer:support:write", missing); w.Code != 400 {
		t.Fatal("missing review", w.Code)
	}
	if w := send(actor, "POST", path+"/cancellation", "not-a-uuid", "customer:support:write", command); w.Code != 400 {
		t.Fatal("invalid key", w.Code)
	}
	recoveryPath := path + "/cancellation/" + key
	decodeRecovery := func(w *httptest.ResponseRecorder) platformCustomerSupportRecovery {
		var out platformCustomerSupportRecovery
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal("recovery", w.Code, w.Body.String())
		}
		return out
	}
	if r := decodeRecovery(send(actor, "GET", recoveryPath, "", "customer:support:read", nil)); r.Recorded {
		t.Fatal("invented request")
	}
	result := send(actor, "POST", path+"/cancellation", key, "customer:support:write", command)
	var receipt platformCustomerSupportRecovery
	if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &receipt) != nil || receipt.Order.Status != "cancelled" || receipt.Order.Cancellation.Status != "approved" || !receipt.Recorded || receipt.RequestID != key {
		t.Fatal("original pre-preparation cancellation", result.Code, result.Body.String())
	}
	cancelled := receipt.Order
	for _, secret := range []string{"customerName", "phone", "address", "trackingToken", "accessCode", "customerId"} {
		if strings.Contains(result.Body.String(), secret) {
			t.Fatal("leaked", secret)
		}
	}
	repeated := send(actor, "POST", path+"/cancellation", key, "customer:support:write", command)
	var again platformCustomerSupportRecovery
	if repeated.Code != 200 || json.Unmarshal(repeated.Body.Bytes(), &again) != nil || again.Order.Version != cancelled.Version {
		t.Fatal("duplicate advanced order")
	}
	changed := command
	changed.Reason = "Different explanation"
	if w := send(actor, "POST", path+"/cancellation", key, "customer:support:write", changed); w.Code != 409 {
		t.Fatal("changed request accepted", w.Code)
	}
	if r := decodeRecovery(send(actor, "GET", recoveryPath, "", "customer:support:read", nil)); !r.Recorded || r.Order.Version != cancelled.Version || r.RequestID != key {
		t.Fatal("lost committed request", r)
	}
	if w := send(other, "GET", recoveryPath, "", "customer:support:read", nil); w.Code != 404 {
		t.Fatal("foreign recovery", w.Code)
	}
	if w := send(actor, "GET", path+"/complaint/"+key, "", "customer:support:read", nil); w.Code != 409 {
		t.Fatal("cross-kind recovery", w.Code)
	}
	// A complaint remains available after cancellation, following the original rule.
	complaintKey := uuid.NewString()
	complaint := platformCustomerSupportInput{Version: cancelled.Version, Reviewed: true, Reason: "Synthetic complaint"}
	if w := send(actor, "POST", path+"/complaint", complaintKey, "customer:support:write", complaint); w.Code != 200 {
		t.Fatal("complaint", w.Code, w.Body.String())
	}
	if r := decodeRecovery(send(actor, "GET", recoveryPath, "", "customer:support:read", nil)); !r.Recorded || len(r.Order.Complaints) != 1 {
		t.Fatal("earlier request lost after later mutation", r)
	}

	latest := decodeRecovery(send(actor, "GET", recoveryPath, "", "customer:support:read", nil))
	reopened, err := s.orders.Reopen(context.Background(), initial.Number, restaurantReopenInput{RequestID: uuid.NewString(), Version: latest.Order.Version, Reason: "Synthetic administrative correction"})
	if err != nil {
		t.Fatal("reopen", err)
	}
	if r := decodeRecovery(send(actor, "GET", recoveryPath, "", "customer:support:read", nil)); !r.Recorded || r.Order.Cancellation != nil || r.Order.Version != reopened.Version {
		t.Fatal("archived request lost after reopen", r)
	}
	if os.Getenv("TEST_CORE_ADAPTER") == "1" {
		service := httptest.NewServer(h)
		defer service.Close()
		der, err := x509.MarshalPKCS8PrivateKey(private)
		if err != nil {
			t.Fatal(err)
		}
		fixture, _ := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "actor": actor, "number": initial.Number, "oldKey": key})
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "integration/customer-support-check.mjs")
		command.Dir = filepath.Join("..", "..", "prototype", "platform")
		command.Env = append(os.Environ(), "CORE_CUSTOMER_SUPPORT_FIXTURE="+string(fixture))
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("actual Node owned support: %v\n%s", err, output)
		}
		t.Log(string(output))
	}
	// Browser credentials are forbidden even with an otherwise valid envelope.
	req := platformTestRequest(t, private, actor, http.MethodGet, path, "", "customer:support:read", nil, nil)
	req.Header.Set("Cookie", "session=synthetic")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("browser cookie accepted", w.Code)
	}
}
