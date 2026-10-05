package main

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestPlatformStaffFinanceUsesOriginalLedgerAndStripsPrivateReferences(t *testing.T) {
	payments, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	before, err := payments.PlatformStaffFinance(ctx, receipt.Order.Number)
	if err != nil || before.CapturedMinor != receipt.Order.TotalMinor || before.AvailableMinor != receipt.Order.TotalMinor || before.ReservedMinor != 0 || len(before.Refunds) != 0 {
		t.Fatal("initial financial snapshot", err)
	}
	intent, err := payments.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1000, Reason: "Synthetic private operator reason", Version: receipt.Order.Version})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := payments.PlatformStaffFinance(ctx, receipt.Order.Number)
	if err != nil || pending.ReservedMinor != 1000 || pending.RefundedMinor != 0 || pending.AvailableMinor != receipt.Order.TotalMinor-1000 || len(pending.Refunds) != 1 || pending.Refunds[0].ID != intent.ID {
		t.Fatal("pending reservation snapshot", err)
	}
	if err = payments.processRefund(ctx, intent.ID); err != nil {
		t.Fatal(err)
	}
	settled, err := payments.PlatformStaffFinance(ctx, receipt.Order.Number)
	if err != nil || settled.RefundedMinor != 1000 || settled.ReservedMinor != 1000 || settled.Refunds[0].Status != "succeeded" {
		t.Fatal("verified settled snapshot", err)
	}
	raw, _ := json.Marshal(settled)
	for _, secret := range []string{"trackingToken", "accessCode", "providerReference", "requestId", "manualReference", "resolutionReason", "customerName", "phone", "Synthetic private"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("finance projection leaked", secret)
		}
	}
	ledger, err := payments.Refunds(ctx, receipt.Order.Number)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(ledger)
	if strings.Contains(string(raw), "customerName") || strings.Contains(string(raw), "trackingToken") {
		t.Fatal("private snapshot changed legacy serialization")
	}
	_, err = payments.PlatformStaffFinance(ctx, "R0000000000")
	restaurantOrdersRequireError(t, err, "invalid_order_access")
}
