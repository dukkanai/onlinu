package main

import (
	"context"
	"testing"
)

func platformLinkInput(version int64, ref string) platformCourierLinkInput {
	return platformCourierLinkInput{ExpectedVersion: &version, OwnerRef: &ref}
}
func TestPlatformCourierLinksExplicitIdentityVersionsBusyRevocationAndAudit(t *testing.T) {
	couriers, orders, db := restaurantCourierFixture(t)
	a := restaurantCourierCreateTest(t, couriers, "link-a")
	b := restaurantCourierCreateTest(t, couriers, "link-b")
	refA := platformPrincipalRef("https://platform.example", "a", "11111111-1111-4111-8111-111111111111")
	refB := platformPrincipalRef("https://platform.example", "a", "22222222-2222-4222-8222-222222222222")
	admin := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{refB, "staff:couriers:link"})
	linked, err := couriers.SetPlatformLink(admin, a.ID, platformLinkInput(0, refA))
	if err != nil || linked.Version != 1 || linked.OwnerRef == nil || *linked.OwnerRef != refA {
		t.Fatal("link failed", err)
	}
	_, err = couriers.SetPlatformLink(admin, b.ID, platformLinkInput(0, refA))
	restaurantOrdersRequireError(t, err, "conflict")
	_, err = couriers.SetPlatformLink(admin, a.ID, platformLinkInput(0, refB))
	restaurantOrdersRequireError(t, err, "conflict")
	rows, err := couriers.PlatformLinks(admin)
	if err != nil || len(rows) != 2 {
		t.Fatal("link roster failed", err)
	}
	receipt := restaurantCourierCreateOrder(t, orders)
	assigned, err := couriers.Assign(context.Background(), receipt.Order.Number, a.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, err = couriers.SetPlatformLink(admin, a.ID, platformLinkInput(1, refB))
	restaurantOrdersRequireError(t, err, "conflict")
	binding, ok, err := couriers.BoundPlatformCourier(admin, refA)
	if err != nil || !ok || binding.ID != a.ID {
		t.Fatal("bound identity lookup failed", err)
	}
	own := context.WithValue(context.Background(), platformCourierBindingKey{}, platformCourierBinding{OwnerRef: refA, Version: binding.Version})
	visible, err := couriers.ListOrders(own, a.ID)
	if err != nil || len(visible) != 1 {
		t.Fatal("bound tasks not visible", err)
	}
	unlinked, err := couriers.SetPlatformLink(admin, a.ID, platformLinkInput(1, ""))
	if err != nil || unlinked.OwnerRef != nil || unlinked.Version != 2 {
		t.Fatal("active native binding could not be revoked", err)
	}
	visible, err = couriers.ListOrders(own, a.ID)
	if err != nil || len(visible) != 0 {
		t.Fatal("revoked binding saw tasks", err)
	}
	if _, err = couriers.SetAvailability(own, a.ID, "available"); err == nil {
		t.Fatal("cached courier identity survived unlink")
	}
	_, err = couriers.SetPlatformLink(admin, a.ID, platformLinkInput(2, refB))
	restaurantOrdersRequireError(t, err, "conflict")
	if _, err = couriers.Assign(context.Background(), assigned.Number, "", assigned.Version); err != nil {
		t.Fatal(err)
	}
	relinked, err := couriers.SetPlatformLink(admin, a.ID, platformLinkInput(2, refB))
	if err != nil || relinked.Version != 3 {
		t.Fatal("relink after unassignment failed", err)
	}
	_, ok, err = couriers.BoundPlatformCourier(admin, refA)
	if err != nil || ok {
		t.Fatal("previous principal remains linked", err)
	}
	_, err = db.Exec(`CREATE FUNCTION reject_courier_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic link audit failure';END $$; CREATE TRIGGER reject_courier_link_audit BEFORE INSERT ON platform_courier_audit FOR EACH ROW EXECUTE FUNCTION reject_courier_link_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = couriers.SetPlatformLink(admin, a.ID, platformLinkInput(3, "")); err == nil {
		t.Fatal("link audit failure ignored")
	}
	current, ok, err := couriers.BoundPlatformCourier(admin, refB)
	if err != nil || !ok || current.Version != 3 {
		t.Fatal("failed link audit did not roll back", err)
	}
}
