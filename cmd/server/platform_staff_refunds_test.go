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

func staffRefundReview(r platformStaffRefundDetail) platformRefundCommand {
	reviewed := true
	return platformRefundCommand{Version: &r.Version, Reviewed: &reviewed, AmountMinor: &r.AmountMinor, Currency: r.Currency, Provider: &r.Provider, Demo: &r.Demo}
}
func staffCancellationIntent(t *testing.T) (*restaurantPayments, platformStaffRefundDetail) {
	t.Helper()
	p, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	if _, err := p.orders.SetStatus(ctx, receipt.Order.Number, "cancelled", receipt.Order.Version); err != nil {
		t.Fatal(err)
	}
	summary, err := p.Refunds(ctx, receipt.Order.Number)
	if err != nil || len(summary.Refunds) != 1 {
		t.Fatal("missing intent", err)
	}
	r, err := p.PlatformRefundDetail(ctx, receipt.Order.Number, summary.Refunds[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	return p, r
}
func TestPlatformStaffRefundReviewedAuthorizationAndAudit(t *testing.T) {
	p, r := staffCancellationIntent(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-manager", "staff:refunds:authorize"})
	good := staffRefundReview(r)
	for _, mutation := range []func(*platformRefundCommand){
		func(i *platformRefundCommand) { i.Reviewed = nil },
		func(i *platformRefundCommand) { v := false; i.Reviewed = &v },
		func(i *platformRefundCommand) { i.Provider = nil },
		func(i *platformRefundCommand) { i.Demo = nil },
	} {
		input := good
		mutation(&input)
		_, err := p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", input)
		restaurantOrdersRequireError(t, err, "invalid_request")
	}
	for _, mutation := range []func(*platformRefundCommand){
		func(i *platformRefundCommand) { v := r.AmountMinor + 1; i.AmountMinor = &v },
		func(i *platformRefundCommand) { v := "wrong"; i.Provider = &v },
		func(i *platformRefundCommand) { v := !r.Demo; i.Demo = &v },
	} {
		input := good
		mutation(&input)
		_, err := p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", input)
		restaurantOrdersRequireError(t, err, "conflict")
	}
	_, err := p.PlatformRefundCommand(context.Background(), r.Number, r.ID, "authorize", good)
	restaurantOrdersRequireError(t, err, "forbidden")
	input := good
	v := r.Version + 1
	input.Version = &v
	_, err = p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", input)
	restaurantOrdersRequireError(t, err, "conflict")
	got, err := p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", good)
	if err != nil || !got.Authorized || got.Version != r.Version+1 {
		t.Fatal("authorization", got, err)
	}
	// Re-reading/repeating the same existing intent cannot create another payout.
	repeated, err := p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", good)
	if err != nil || repeated.ID != r.ID || repeated.Version != got.Version {
		t.Fatal("existing intent recovery", err)
	}
	var count int
	if err = p.db.QueryRowContext(ctx, `SELECT count(*) FROM platform_staff_refund_audit WHERE refund_id=$1 AND actor_id='synthetic-manager' AND scope='staff:refunds:authorize'`, r.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("transactional attribution", count, err)
	}
	raw, _ := json.Marshal(got)
	for _, secret := range []string{"trackingToken", "requestId", "accessCode", "customerName", "phone"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("private capability leak", secret)
		}
	}
}
func TestPlatformStaffRefundAuditFailureRollsBackAuthorization(t *testing.T) {
	p, r := staffCancellationIntent(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-manager", "staff:refunds:authorize"})
	_, err := p.db.ExecContext(ctx, `CREATE FUNCTION reject_staff_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_staff_refund_audit BEFORE INSERT ON platform_staff_refund_audit FOR EACH ROW EXECUTE FUNCTION reject_staff_refund_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.PlatformRefundCommand(ctx, r.Number, r.ID, "authorize", staffRefundReview(r)); err == nil {
		t.Fatal("audit failure ignored")
	}
	after, err := p.PlatformRefundDetail(ctx, r.Number, r.ID)
	if err != nil || after.Authorized || after.Version != r.Version {
		t.Fatal("failed audit committed financial authority", after, err)
	}
}

func TestPlatformStaffRefundManualReportPreservesUnconfirmedMoney(t *testing.T) {
	p, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, receipt.Order.Number))
	if err != nil {
		t.Fatal(err)
	}
	order := stored.order
	order.Payment.Provider = "geidea"
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	r, err := p.RequestRefund(ctx, order.Number, restaurantRefundInput{RequestID: "11111111-1111-4111-8111-111111111111", AmountMinor: 1000, Reason: "Synthetic manual intent", Version: order.Version})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := p.PlatformRefundDetail(ctx, order.Number, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	input := staffRefundReview(detail)
	input.Reference = "synthetic-merchant-receipt"
	input.Reason = "Synthetic operator reports prior external refund"
	actorCtx := context.WithValue(ctx, platformStaffActorKey{}, platformStaffActor{"synthetic-manager", "staff:refunds:manual"})
	result, err := p.PlatformRefundCommand(actorCtx, order.Number, r.ID, "manual", input)
	if err != nil || result.Status != "manual_reported" || result.Confirmation != "manual" || result.ManualReference != input.Reference {
		t.Fatal("manual report", result, err)
	}
	finance, err := p.PlatformStaffFinance(ctx, order.Number)
	if err != nil || finance.RefundedMinor != 0 || finance.ReservedMinor != 1000 {
		t.Fatal("manual report misrepresented as provider confirmation", finance, err)
	}
	raw, _ := json.Marshal(finance)
	if strings.Contains(string(raw), input.Reference) || strings.Contains(string(raw), input.Reason) {
		t.Fatal("manager reference leaked to financial summary")
	}
	var count int
	if err = p.db.QueryRowContext(ctx, `SELECT count(*) FROM platform_staff_refund_audit WHERE refund_id=$1 AND actor_id='synthetic-manager'`, r.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("manual audit", count, err)
	}
}

func TestPlatformStaffRefundSignedRoutesRejectScopeAndBrowserReplay(t *testing.T) {
	p, detail := staffCancellationIntent(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{payments: p, orders: p.orders, platformAuth: &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}}
	mux := http.NewServeMux()
	s.registerPlatformOrderRoutes(mux)
	actor := uuid.NewString()
	path := "/platform-api/staff/orders/" + detail.Number + "/refunds/" + detail.ID
	send := func(req *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w
	}
	for _, scope := range []string{"orders:read", "staff:payments:read", "staff:refunds:authorize"} {
		w := send(platformTestRequest(t, private, actor, "GET", path, "", scope, nil, nil))
		if w.Code == 200 {
			t.Fatal("manager detail accepted incorrect scope", scope)
		}
	}
	if w := send(platformTestRequest(t, private, actor, "GET", path, "", "staff:refunds:read", nil, nil)); w.Code != 200 {
		t.Fatal("signed read", w.Code, w.Body.String())
	}
	input := staffRefundReview(detail)
	for _, header := range []string{"Cookie", "Origin"} {
		req := platformTestRequest(t, private, actor, "POST", path+"/authorize", "", "staff:refunds:authorize", input, nil)
		req.Header.Set(header, "synthetic-browser")
		if w := send(req); w.Code == 200 {
			t.Fatal("browser replay accepted", header)
		}
	}
	if w := send(platformTestRequest(t, private, actor, "POST", path+"/authorize", "", "staff:refunds:authorize", input, nil)); w.Code != 200 {
		t.Fatal("signed authorization", w.Code, w.Body.String())
	}
	if w := send(platformTestRequest(t, private, actor, "GET", path+"?debug=1", "", "staff:refunds:read", nil, nil)); w.Code != 400 {
		t.Fatal("unexpected query accepted", w.Code)
	}
}

func TestPlatformStaffRefundActualNodeSignedCommands(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("requires Node adapter fixture")
	}
	p, detail := staffCancellationIntent(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{payments: p, orders: p.orders, platformAuth: &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}}
	mux := http.NewServeMux()
	s.registerPlatformOrderRoutes(mux)
	service := httptest.NewServer(mux)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "number": detail.Number, "refundId": detail.ID})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "integration/refund-control-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "CORE_REFUND_FIXTURE="+string(fixture))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("refund adapter: %v\n%s", err, output)
	}
	t.Log(string(output))
}
