package main

import (
	"sync"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestRestaurantWhatsappQRSourceFencesProviderAndAttachment(t *testing.T) {
	binding, own, event, now := whatsappQRDecisionFixture("تأكيد")
	ingress, err := newRestaurantWhatsappQRIngress(binding.RestaurantID)
	if err != nil {
		t.Fatal(err)
	}
	firstClient, otherClient := &whatsmeow.Client{}, &whatsmeow.Client{}
	first, err := ingress.Attach(firstClient, binding, own)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = first.Text(otherClient, event, now); err == nil {
		t.Fatal("foreign provider accepted")
	}
	if _, err = first.Decision(otherClient, event, now); err == nil {
		t.Fatal("foreign confirmation provider accepted")
	}
	original, err := first.Decision(firstClient, event, now)
	if err != nil {
		t.Fatal(err)
	}
	binding.Generation = "replacement-generation"
	second, err := ingress.Attach(otherClient, binding, own)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = first.Text(firstClient, event, now); err == nil {
		t.Fatal("late old event adopted by replacement")
	}
	if _, err = first.Decision(firstClient, event, now); err == nil {
		t.Fatal("old confirmation adopted by replacement")
	}
	first.ObserveLifecycle(firstClient, &events.LoggedOut{})
	current, err := second.Decision(otherClient, event, now)
	if err != nil {
		t.Fatal("late logout revoked replacement", err)
	}
	if original.scope.Generation == current.scope.Generation || original.scope.Generation != "generation-test" {
		t.Fatal("returned intent scope was relabeled")
	}
	// Reconnect may keep the durable epoch, but gets a distinct callback attachment.
	third, err := ingress.Attach(otherClient, binding, own)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = second.Text(otherClient, event, now); err == nil {
		t.Fatal("same-client stale attachment remained live")
	}
	if _, err = third.Text(otherClient, event, now); err != nil {
		t.Fatal(err)
	}
	bad := binding
	bad.RestaurantID = "foreign-tenant"
	if _, err = ingress.Attach(otherClient, bad, own); err == nil {
		t.Fatal("foreign tenant attached")
	}
	if _, err = third.Text(otherClient, event, now); err != nil {
		t.Fatal("invalid attach destroyed current source", err)
	}
}

func TestRestaurantWhatsappQRSourceFailuresNeverAutoReactivate(t *testing.T) {
	failures := []any{&events.LoggedOut{}, &events.Disconnected{}, &events.StreamReplaced{}, &events.TemporaryBan{}, &events.ClientOutdated{}, &events.ConnectFailure{}, &events.StreamError{}, &events.CATRefreshError{}}
	for _, failure := range failures {
		binding, own, event, now := whatsappQRDecisionFixture("CONFIRM")
		ingress, err := newRestaurantWhatsappQRIngress(binding.RestaurantID)
		if err != nil {
			t.Fatal(err)
		}
		client, foreign := &whatsmeow.Client{}, &whatsmeow.Client{}
		source, err := ingress.Attach(client, binding, own)
		if err != nil {
			t.Fatal(err)
		}
		source.ObserveLifecycle(foreign, failure)
		if _, err = source.Text(client, event, now); err != nil {
			t.Fatal("foreign lifecycle affected source", err)
		}
		source.ObserveLifecycle(client, failure)
		source.ObserveLifecycle(client, &events.Connected{})
		if _, err = source.Text(client, event, now); err == nil {
			t.Fatalf("%T source reactivated implicitly", failure)
		}
		if _, err = source.Decision(client, event, now); err == nil {
			t.Fatalf("%T decision accepted after failure", failure)
		}
	}
	var empty *restaurantWhatsappQRSource
	empty.Invalidate()
	empty.ObserveLifecycle(nil, &events.Disconnected{})
}

func TestRestaurantWhatsappQRSourceConcurrentInvalidateAndExtract(t *testing.T) {
	binding, own, event, now := whatsappQRDecisionFixture("CONFIRM")
	ingress, err := newRestaurantWhatsappQRIngress(binding.RestaurantID)
	if err != nil {
		t.Fatal(err)
	}
	client := &whatsmeow.Client{}
	source, err := ingress.Attach(client, binding, own)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				intent, e := source.Text(client, event, now)
				if e == nil && intent.scope.Generation != binding.Generation {
					t.Error("scope relabeled")
				}
			}
		}()
	}
	source.Invalidate()
	wg.Wait()
	if _, err = source.Text(client, event, now); err == nil {
		t.Fatal("invalidation did not fence subsequent events")
	}
	if _, err = ingress.Attach(nil, binding, own); err == nil {
		t.Fatal("nil provider accepted")
	}
	if _, err = ingress.Attach(client, binding, types.EmptyJID); err == nil {
		t.Fatal("missing own identity accepted")
	}
}
