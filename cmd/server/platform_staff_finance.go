package main

import (
	"context"
	"net/http"
	"time"
)

// Read-only financial projection from one repeatable-read original ledger
// snapshot. No receipt capabilities, customer contacts, private references,
// provider configuration or operator free-text notes cross this boundary.
type platformStaffRefundView struct {
	ID           string    `json:"id"`
	Version      int64     `json:"version"`
	Status       string    `json:"status"`
	Provider     string    `json:"provider"`
	Currency     string    `json:"currency"`
	AmountMinor  int64     `json:"amountMinor"`
	TaxMinor     int64     `json:"taxMinor"`
	Confirmation string    `json:"confirmation"`
	Authorized   bool      `json:"authorized"`
	Submitted    bool      `json:"submitted"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}
type platformStaffFinance struct {
	Number         string                     `json:"number"`
	OrderVersion   int64                      `json:"orderVersion"`
	TotalMinor     int64                      `json:"totalMinor"`
	Currency       string                     `json:"currency"`
	PaymentMethod  string                     `json:"paymentMethod"`
	PaymentStatus  string                     `json:"paymentStatus"`
	Provider       string                     `json:"provider"`
	Demo           bool                       `json:"demo"`
	CapturedMinor  int64                      `json:"capturedMinor"`
	ReservedMinor  int64                      `json:"reservedMinor"`
	RefundedMinor  int64                      `json:"refundedMinor"`
	AvailableMinor int64                      `json:"availableMinor"`
	Capability     restaurantRefundCapability `json:"capability"`
	Refunds        []platformStaffRefundView  `json:"refunds"`
	Limit          int                        `json:"limit"`
}

func (p *restaurantPayments) PlatformStaffFinance(ctx context.Context, number string) (platformStaffFinance, error) {
	summary, err := p.Refunds(ctx, number)
	if err != nil {
		return platformStaffFinance{}, err
	}
	order := summary.order
	result := platformStaffFinance{Number: order.Number, OrderVersion: order.Version, TotalMinor: order.TotalMinor, Currency: order.Currency, PaymentMethod: order.Payment.Method, PaymentStatus: order.Payment.Status, Provider: order.Payment.Provider, Demo: order.Demo, CapturedMinor: summary.CapturedMinor, ReservedMinor: summary.ReservedMinor, RefundedMinor: summary.RefundedMinor, AvailableMinor: summary.AvailableMinor, Capability: summary.Capability, Refunds: []platformStaffRefundView{}, Limit: 100}
	for _, r := range summary.Refunds {
		result.Refunds = append(result.Refunds, staffRefundView(r))
	}
	return result, nil
}
func (s *server) registerPlatformStaffFinanceRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/orders/{number}/finance", wrap("staff:payments:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		view, err := s.payments.PlatformStaffFinance(r.Context(), r.PathValue("number"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
}

func staffRefundView(r restaurantRefund) platformStaffRefundView {
	return platformStaffRefundView{r.ID, r.Version, r.Status, r.Provider, r.Currency, r.AmountMinor, r.TaxMinor, r.Confirmation, r.Authorized, r.Submitted, r.CreatedAt, r.UpdatedAt}
}
