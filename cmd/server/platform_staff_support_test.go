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

func staffSupportActor(action string) context.Context {
	return context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-support-manager", "staff:support:" + action})
}
func staffPaidCancellation(t *testing.T) (*restaurantPayments, restaurantOrder, string) {
	t.Helper()
	p, receipt, _ := restaurantRefundFixture(t)
	o := receipt.Order
	ctx := context.Background()
	var err error
	for _, status := range []string{"accepted", "preparing"} {
		o, err = p.orders.SetStatus(ctx, o.Number, status, o.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	o, err = p.orders.RequestCancellation(ctx, o.Number, receipt.TrackingToken, "", "", "Synthetic private customer reason", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	return p, o, receipt.TrackingToken
}
func TestPlatformStaffSupportReviewedCancellationCreatesNoPayoutAuthority(t *testing.T) {
	p, o, _ := staffPaidCancellation(t)
	ctx := staffSupportActor("decide")
	approve := true
	input := platformStaffSupportCommand{Version: o.Version, Reviewed: true, Approve: &approve, Reason: "Synthetic approved cancellation"}
	missing := input
	missing.Approve = nil
	_, err := p.orders.PlatformSupportCommand(ctx, o.Number, o.Cancellation.ID, "decide", missing)
	restaurantOrdersRequireError(t, err, "invalid_request")
	missing = input
	missing.Reviewed = false
	_, err = p.orders.PlatformSupportCommand(ctx, o.Number, o.Cancellation.ID, "decide", missing)
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = p.orders.PlatformSupportCommand(context.Background(), o.Number, o.Cancellation.ID, "decide", input)
	restaurantOrdersRequireError(t, err, "forbidden")
	_, err = p.orders.PlatformSupportCommand(ctx, o.Number, uuid.NewString(), "decide", input)
	restaurantOrdersRequireError(t, err, "conflict")
	stale := input
	stale.Version--
	_, err = p.orders.PlatformSupportCommand(ctx, o.Number, o.Cancellation.ID, "decide", stale)
	restaurantOrdersRequireError(t, err, "conflict")
	queue, err := p.orders.PlatformSupportQueue(ctx)
	if err != nil || len(queue.Orders) != 1 || !queue.Orders[0].CancellationPending {
		t.Fatal("pending queue", queue, err)
	}
	raw, _ := json.Marshal(queue)
	if strings.Contains(string(raw), "private customer reason") {
		t.Fatal("queue leaked reason")
	}
	result, err := p.orders.PlatformSupportCommand(ctx, o.Number, o.Cancellation.ID, "decide", input)
	if err != nil || result.Status != "cancelled" || result.Cancellation.Status != "approved" || result.Version != o.Version+1 || result.TotalMinor != o.TotalMinor {
		t.Fatal("reviewed decision", result, err)
	}
	ledger, err := p.Refunds(ctx, o.Number)
	if err != nil || len(ledger.Refunds) != 1 || ledger.Refunds[0].Authorized || ledger.Refunds[0].Submitted || ledger.RefundedMinor != 0 {
		t.Fatal("cancellation implied refund payout", ledger, err)
	}
	var actor string
	if err = p.db.QueryRowContext(ctx, `SELECT actor_id FROM platform_staff_order_audit WHERE order_number=$1 AND version=$2`, o.Number, result.Version).Scan(&actor); err != nil || actor != "synthetic-support-manager" {
		t.Fatal("missing attribution", actor, err)
	}
	raw, _ = json.Marshal(result)
	for _, secret := range []string{"trackingToken", "accessCode", "customerName", "phone", "customerId", "sealedSecrets"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("support projection leak", secret)
		}
	}
	queue, err = p.orders.PlatformSupportQueue(ctx)
	if err != nil || len(queue.Orders) != 0 {
		t.Fatal("resolved cancellation stayed queued", err)
	}
}
func TestPlatformStaffSupportCancellationAuditFailureRollsBackRefundIntent(t *testing.T) {
	p, o, _ := staffPaidCancellation(t)
	ctx := staffSupportActor("decide")
	approve := true
	_, err := p.db.ExecContext(ctx, `CREATE FUNCTION reject_support_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;CREATE TRIGGER reject_support_audit BEFORE INSERT ON platform_staff_order_audit FOR EACH ROW EXECUTE FUNCTION reject_support_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.orders.PlatformSupportCommand(ctx, o.Number, o.Cancellation.ID, "decide", platformStaffSupportCommand{Version: o.Version, Reviewed: true, Approve: &approve, Reason: "Synthetic manager review"})
	if err == nil {
		t.Fatal("audit failure ignored")
	}
	after, err := p.orders.PlatformSupportDetail(ctx, o.Number)
	if err != nil || after.Version != o.Version || after.Status != o.Status || after.Cancellation.Status != "requested" {
		t.Fatal("decision committed despite audit failure", after, err)
	}
	ledger, err := p.Refunds(ctx, o.Number)
	if err != nil || len(ledger.Refunds) != 0 {
		t.Fatal("refund intent survived rollback", ledger, err)
	}
}
func TestPlatformStaffSupportOldestQueueLimitAndComplaintResolution(t *testing.T) {
	orders, input := restaurantStockFixture(t, 110)
	ctx := context.Background()
	var first restaurantOrder
	for i := 0; i < 101; i++ {
		receipt, err := orders.Create(ctx, input, "", uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		order, err := orders.ReportComplaint(ctx, receipt.Order.Number, receipt.TrackingToken, "", "", "Synthetic complaint", uuid.NewString(), receipt.Order.Version)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = order
		}
	}
	queue, err := orders.PlatformSupportQueue(ctx)
	if err != nil || len(queue.Orders) != 100 || !queue.HasMore || queue.Orders[0].Number != first.Number {
		t.Fatal("bounded oldest queue", len(queue.Orders), queue.HasMore, err)
	}
	result, err := orders.PlatformSupportCommand(staffSupportActor("resolve"), first.Number, first.Complaints[0].ID, "resolve", platformStaffSupportCommand{Version: first.Version, Reviewed: true, Reason: "Synthetic replacement agreed"})
	if err != nil || result.Status != first.Status || result.Complaints[0].Status != "resolved" || result.TotalMinor != first.TotalMinor {
		t.Fatal("complaint resolution altered order/money", result, err)
	}
	queue, err = orders.PlatformSupportQueue(ctx)
	if err != nil || len(queue.Orders) != 100 || queue.HasMore || queue.Orders[0].Number == first.Number {
		t.Fatal("queue did not advance", queue.HasMore, err)
	}
}

func TestPlatformStaffSupportActualNodeCommands(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("requires Node fixture")
	}
	p, o, token := staffPaidCancellation(t)
	o, err := p.orders.ReportComplaint(context.Background(), o.Number, token, "", "", "Synthetic missing sauce", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	o, err = p.orders.ReportComplaint(context.Background(), o.Number, token, "", "", "Synthetic additional complaint", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{orders: p.orders, payments: p, platformAuth: &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}}
	mux := http.NewServeMux()
	s.registerPlatformOrderRoutes(mux)
	service := httptest.NewServer(mux)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "number": o.Number})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "integration/support-control-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "CORE_SUPPORT_FIXTURE="+string(fixture))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("support adapter: %v\n%s", err, output)
	}
	t.Log(string(output))
	ledger, err := p.Refunds(ctx, o.Number)
	if err != nil || len(ledger.Refunds) != 1 || ledger.Refunds[0].Authorized || ledger.Refunds[0].Submitted || ledger.RefundedMinor != 0 {
		t.Fatal("support flow authorized money", ledger, err)
	}
}
