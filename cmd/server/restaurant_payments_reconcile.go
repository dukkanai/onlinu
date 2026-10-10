package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"
)

// These operational limits balance provider traffic against best-effort recovery;
// they are not a provider refund deadline or a promise to discover every refund.
type restaurantPaymentSettlementPolicy struct {
	WatchDays    int `json:"watchDays"`
	CheckMinutes int `json:"checkMinutes"`
}

func restaurantPaymentSettlementPolicyFromEnv() (restaurantPaymentSettlementPolicy, error) {
	p := restaurantPaymentSettlementPolicy{WatchDays: 30, CheckMinutes: 60}
	for _, setting := range []struct {
		key      string
		value    *int
		min, max int
	}{
		{"WACALLS_PAYMENT_SETTLEMENT_WATCH_DAYS", &p.WatchDays, 1, 365},
		{"WACALLS_PAYMENT_SETTLEMENT_CHECK_MINUTES", &p.CheckMinutes, 15, 1440},
	} {
		if raw, exists := os.LookupEnv(setting.key); exists {
			v, err := strconv.Atoi(raw)
			if err != nil || v < setting.min || v > setting.max {
				return p, fmt.Errorf("%s must be an integer from %d to %d", setting.key, setting.min, setting.max)
			}
			*setting.value = v
		}
	}
	return p, nil
}

// Legacy attempts have no new watch anchor. Use creation time conservatively:
// migration must not infer a capture or restart monitoring for old paid orders.
const restaurantPaymentSettlementWatched = `(status='paid' OR (status='review' AND capture_verified))`
const restaurantPaymentSettlementDue = `NOT needs_refresh AND ` + restaurantPaymentSettlementWatched + ` AND remote_id<>''
 AND COALESCE(settlement_watch_started_at,created_at) > now()-($1 * interval '1 day')
 AND (checked_at IS NULL OR checked_at < now()-($2 * interval '1 minute'))`

func (p *restaurantPayments) reconciliationAttempts(ctx context.Context, suffix string, args ...any) ([]restaurantPaymentAttempt, error) {
	rows, err := p.db.QueryContext(ctx, restaurantPaymentAttemptSelect+suffix, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attempts := []restaurantPaymentAttempt{}
	for rows.Next() {
		a, err := p.readAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, a)
	}
	return attempts, rows.Err()
}

func (p *restaurantPayments) Reconcile(ctx context.Context) error {
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		return err
	}
	urgent, err := p.reconciliationAttempts(ctx, ` WHERE (needs_refresh OR ((status IN ('creating','pending') OR (status='review' AND NOT capture_verified)) AND created_at > now()-interval '7 days'))
 AND (checked_at IS NULL OR checked_at < now()-interval '30 seconds') ORDER BY checked_at NULLS FIRST,id LIMIT 8`)
	if err != nil {
		return err
	}
	settlements, err := p.reconciliationAttempts(ctx, ` WHERE `+restaurantPaymentSettlementDue+` ORDER BY checked_at NULLS FIRST,id LIMIT 2`, p.settlementPolicy.WatchDays, p.settlementPolicy.CheckMinutes)
	if err != nil {
		return err
	}
	// Reserve both request slots and time for each queue. A large/slow pending
	// backlog cannot starve settlement reads, nor can settlement polling consume all
	// pending/hook capacity. Rows still cooling down never occupy these slots.
	for _, group := range []struct {
		attempts         []restaurantPaymentAttempt
		budget, interval time.Duration
	}{
		{urgent, 25 * time.Second, 30 * time.Second},
		{settlements, 20 * time.Second, time.Duration(p.settlementPolicy.CheckMinutes) * time.Minute},
	} {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		batch, cancel := context.WithTimeout(ctx, group.budget)
		for _, a := range group.attempts {
			if batch.Err() != nil {
				break
			}
			_, _ = p.refreshAttemptAfter(batch, a, group.interval)
		}
		cancel()
	}
	return ctx.Err()
}

type restaurantPaymentReconciliationSummary struct {
	restaurantPaymentSettlementPolicy
	SettlementBatchLimit           int   `json:"settlementBatchLimit"`
	DueSettlements                 int64 `json:"dueSettlements"`
	OverdueSettlements             int64 `json:"overdueSettlements"`
	OutsideAutomaticWindow         int64 `json:"outsideAutomaticWindow"`
	PendingRefreshes               int64 `json:"pendingRefreshes"`
	StripeUnresolvedEvents         int64 `json:"stripeUnresolvedEvents"`
	StripeRejectedEvents           int64 `json:"stripeRejectedEvents"`
	StripeReceiptCapacityRemaining int64 `json:"stripeReceiptCapacityRemaining"`
}

// Expose only operational counts through the existing authenticated payment
// administration route. Outside-window payments require hooks/explicit refresh;
// an overdue check is not financial evidence and never rewrites payment status.
func (p *restaurantPayments) ReconciliationSummary(ctx context.Context) (restaurantPaymentReconciliationSummary, error) {
	s := restaurantPaymentReconciliationSummary{restaurantPaymentSettlementPolicy: p.settlementPolicy, SettlementBatchLimit: 2}
	err := p.db.QueryRowContext(ctx, `SELECT
 count(*) FILTER (WHERE `+restaurantPaymentSettlementDue+`),
 count(*) FILTER (WHERE `+restaurantPaymentSettlementDue+` AND (checked_at IS NULL OR checked_at < now()-($2 * interval '2 minutes'))),
 count(*) FILTER (WHERE NOT needs_refresh AND `+restaurantPaymentSettlementWatched+` AND COALESCE(settlement_watch_started_at,created_at) <= now()-($1 * interval '1 day')),
 count(*) FILTER (WHERE needs_refresh)
 FROM restaurant_payment_attempts`, p.settlementPolicy.WatchDays, p.settlementPolicy.CheckMinutes).Scan(&s.DueSettlements, &s.OverdueSettlements, &s.OutsideAutomaticWindow, &s.PendingRefreshes)
	if err != nil {
		return s, err
	}
	err = p.db.QueryRowContext(ctx, `SELECT count(*) FILTER(WHERE state='pending'),count(*) FILTER(WHERE state='rejected'),GREATEST($1-count(*),0) FROM restaurant_stripe_webhook_receipts`, restaurantStripeReceiptLimit).Scan(&s.StripeUnresolvedEvents, &s.StripeRejectedEvents, &s.StripeReceiptCapacityRemaining)
	return s, err
}
