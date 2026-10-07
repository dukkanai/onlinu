package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestRestaurantWhatsappInboxConcurrentDurableReceipts(t *testing.T) {
	orders, _ := restaurantStockFixture(t, 4)
	ctx := context.Background()
	inbox, err := newRestaurantWhatsappInbox(ctx, orders.store.db)
	if err != nil {
		t.Fatal(err)
	}
	scope, source, items, now := whatsappProposalFixture()
	source.SentAt = source.SentAt.Add(123456789 * time.Nanosecond)
	proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	const workers = 12
	receipts := make(chan restaurantWhatsappInboxReceipt, workers)
	errors := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, err := inbox.Record(ctx, proposal, now)
			if err != nil {
				errors <- err
			} else {
				receipts <- receipt
			}
		}()
	}
	wg.Wait()
	close(receipts)
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	created, duplicates := 0, 0
	for receipt := range receipts {
		if receipt.EventKey != proposal.eventKey || receipt.PayloadHash != proposal.payloadHash || receipt.Expired || !receipt.FirstSeenAt.Equal(now) {
			t.Fatal("invalid durable receipt", receipt)
		}
		if receipt.Duplicate {
			duplicates++
		} else {
			created++
		}
	}
	if created != 1 || duplicates != workers-1 {
		t.Fatal("duplicate creation", created, duplicates)
	}
	restarted, err := newRestaurantWhatsappInbox(ctx, orders.store.db)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := restarted.Record(ctx, proposal, now.Add(time.Hour))
	if err != nil || !receipt.Duplicate || !receipt.Expired || !receipt.FirstSeenAt.Equal(now) || !receipt.ExpiresAt.Equal(proposal.expiresAt.Truncate(time.Microsecond)) {
		t.Fatal("restart renewed expired receipt", receipt, err)
	}
	var count int
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_whatsapp_inbox").Scan(&count); err != nil || count != 1 {
		t.Fatal("wrong inbox count", count, err)
	}
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 0 {
		t.Fatal("inbox created order", count, err)
	}
	restaurantAssertStock(t, orders, 4, 0)
}

func TestRestaurantWhatsappInboxConflictsIsolationAndExpiry(t *testing.T) {
	orders, _, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	inbox, err := newRestaurantWhatsappInbox(ctx, orders.store.db)
	if err != nil {
		t.Fatal(err)
	}
	scope, source, items, now := whatsappProposalFixture()
	proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = inbox.Record(ctx, proposal, now.Add(time.Hour))
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
	first, err := inbox.Record(ctx, proposal, now)
	if err != nil {
		t.Fatal(err)
	}
	items[0].Quantity = 2
	conflict, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = inbox.Record(ctx, conflict, now)
	restaurantOrdersRequireError(t, err, "whatsapp_message_conflict")
	original, err := inbox.Record(ctx, proposal, now)
	if err != nil || original.PayloadHash != first.PayloadHash || !original.Duplicate {
		t.Fatal("conflict overwrote original", err)
	}
	// Same provider message ID in another connection generation is independent.
	scope.Generation = "relinked-generation"
	other, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := inbox.Record(ctx, other, now)
	if err != nil || receipt.Duplicate || receipt.EventKey == first.EventKey {
		t.Fatal("relinked account collision", err)
	}
	mutated := *proposal
	mutated.expiresAt = mutated.expiresAt.Add(time.Hour)
	_, err = inbox.Record(ctx, &mutated, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	var count int
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_whatsapp_inbox").Scan(&count); err != nil || count != 2 {
		t.Fatal("rejected event persisted", count, err)
	}
	// Corrupt durable data is rejected, not silently repaired or reused.
	_, err = orders.store.db.Exec("UPDATE restaurant_whatsapp_inbox SET items='[]'::jsonb WHERE event_key=$1", proposal.eventKey)
	if err != nil {
		t.Fatal(err)
	}
	_, err = inbox.Record(ctx, proposal, now)
	restaurantOrdersRequireError(t, err, "whatsapp_inbox_inconsistent")
}

func TestRestaurantWhatsappInboxRejectsMissingPrivateInputs(t *testing.T) {
	_, err := (*restaurantWhatsappInbox)(nil).Record(context.Background(), nil, time.Now())
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
}
