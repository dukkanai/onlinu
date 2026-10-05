package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

type platformCourierAddress struct {
	AddressLine      string   `json:"addressLine"`
	NationalAddress  string   `json:"nationalAddress"`
	City             string   `json:"city"`
	District         string   `json:"district"`
	Street           string   `json:"street"`
	Building         string   `json:"building"`
	PostalCode       string   `json:"postalCode"`
	AdditionalNumber string   `json:"additionalNumber"`
	Latitude         *float64 `json:"latitude"`
	Longitude        *float64 `json:"longitude"`
}
type platformCourierOrderDetail struct {
	platformStaffOrderSummary
	BindingVersion int64                  `json:"bindingVersion"`
	CustomerName   string                 `json:"customerName"`
	Phone          string                 `json:"phone"`
	Address        platformCourierAddress `json:"address"`
	Items          []restaurantOrderLine  `json:"items"`
	Notes          string                 `json:"notes"`
}

func (s *restaurantCouriers) PlatformOwnDetail(ctx context.Context, binding platformCourierBinding, number string) (platformCourierOrderDetail, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT o.document FROM restaurant_orders o JOIN restaurant_couriers c ON c.id=o.document->>'courierId' JOIN platform_courier_links l ON l.courier_id=c.id
 WHERE o.number=$1 AND o.document->>'mode'='delivery' AND c.active AND l.owner_ref=$2 AND l.version=$3 AND o.status NOT IN ('completed','cancelled') AND COALESCE(o.document->>'deliveryStatus','')<>'delivered'`, number, binding.OwnerRef, binding.Version).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return platformCourierOrderDetail{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return platformCourierOrderDetail{}, err
	}
	var order restaurantOrder
	if err = json.Unmarshal(raw, &order); err != nil {
		return platformCourierOrderDetail{}, err
	}
	a := order.Address
	return platformCourierOrderDetail{platformStaffOrderSummary: staffOrderSummary(order), BindingVersion: binding.Version, CustomerName: order.CustomerName, Phone: order.Phone,
		Address: platformCourierAddress{a.AddressLine, a.NationalAddress, a.City, a.District, a.Street, a.Building, a.PostalCode, a.AdditionalNumber, a.Latitude, a.Longitude}, Items: order.Items, Notes: order.Notes}, nil
}
func (s *server) registerPlatformCourierWorkRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/courier-links", wrap("staff:couriers:link", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		links, err := s.couriers.PlatformLinks(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"links": links, "limit": 500})
	}))
	mux.HandleFunc("POST /platform-api/staff/courier-links/{id}", wrap("staff:couriers:link", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		var input platformCourierLinkInput
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:couriers:link"})
		result, err := s.couriers.SetPlatformLink(ctx, r.PathValue("id"), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, result)
	}))
	mux.HandleFunc("GET /platform-api/courier/work", wrap("courier:read", func(w http.ResponseWriter, r *http.Request, _ []byte, actor string) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		bound, ok, err := s.couriers.BoundPlatformCourier(r.Context(), actor)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		var courier *platformStaffCourier
		rows := []platformStaffOrderSummary{}
		var version int64
		if ok {
			version = bound.Version
			courier = &bound.platformStaffCourier
			ctx := context.WithValue(r.Context(), platformCourierBindingKey{}, platformCourierBinding{OwnerRef: actor, Version: version})
			orders, loadErr := s.couriers.ListOrders(ctx, bound.ID)
			if loadErr != nil {
				writeRestaurantError(w, loadErr)
				return
			}
			for _, order := range orders {
				rows = append(rows, staffOrderSummary(order))
			}
		}
		writeJSON(w, 200, map[string]any{"courier": courier, "bindingVersion": version, "orders": rows, "limit": 100})
	}))
	mux.HandleFunc("GET /platform-api/courier/orders/{number}", wrap("courier:read", func(w http.ResponseWriter, r *http.Request, _ []byte, actor string) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		bound, ok, err := s.couriers.BoundPlatformCourier(r.Context(), actor)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeRestaurantError(w, restaurantFail(403, "forbidden"))
			return
		}
		view, err := s.couriers.PlatformOwnDetail(r.Context(), platformCourierBinding{OwnerRef: actor, Version: bound.Version}, r.PathValue("number"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
	for _, operation := range []struct{ path, scope string }{{"status", "courier:orders:update"}, {"cash", "courier:cash:collect"}} {
		mux.HandleFunc("POST /platform-api/courier/orders/{number}/"+operation.path, wrap(operation.scope, func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if s.couriers == nil {
				writeRestaurantError(w, restaurantFail(503, "server_error"))
				return
			}
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			var version, bindingVersion *int64
			var status string
			r.Body = io.NopCloser(bytes.NewReader(body))
			if operation.path == "status" {
				var input struct {
					Version        *int64 `json:"version"`
					BindingVersion *int64 `json:"bindingVersion"`
					Status         string `json:"status"`
				}
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				version, bindingVersion, status = input.Version, input.BindingVersion, input.Status
			} else {
				var input struct {
					Version        *int64 `json:"version"`
					BindingVersion *int64 `json:"bindingVersion"`
				}
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				version, bindingVersion, status = input.Version, input.BindingVersion, "at_door"
			}
			if version == nil || bindingVersion == nil || *version < 1 || *bindingVersion < 1 {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			bound, ok, err := s.couriers.BoundPlatformCourier(r.Context(), actor)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			if !ok {
				writeRestaurantError(w, restaurantFail(403, "forbidden"))
				return
			}
			if bound.Version != *bindingVersion {
				writeRestaurantError(w, restaurantFail(409, "conflict"))
				return
			}
			ctx := context.WithValue(r.Context(), platformCourierBindingKey{}, platformCourierBinding{OwnerRef: actor, Version: bound.Version, CashOnly: operation.path == "cash"})
			ctx = context.WithValue(ctx, platformStaffActorKey{}, platformStaffActor{actor, operation.scope})
			order, err := s.couriers.UpdateOrder(ctx, bound.ID, r.PathValue("number"), status, *version, operation.path == "cash")
			if err != nil {
				var problem *restaurantError
				if errors.As(err, &problem) && problem.Code == "unauthorized" {
					err = restaurantFail(403, "forbidden")
				}
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, staffOrderSummary(order))
		}))
	}
	mux.HandleFunc("POST /platform-api/courier/availability", wrap("courier:availability:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		var input struct {
			BindingVersion *int64 `json:"bindingVersion"`
			Availability   string `json:"availability"`
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		if input.BindingVersion == nil || *input.BindingVersion < 1 {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		bound, ok, err := s.couriers.BoundPlatformCourier(r.Context(), actor)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeRestaurantError(w, restaurantFail(403, "forbidden"))
			return
		}
		if bound.Version != *input.BindingVersion {
			writeRestaurantError(w, restaurantFail(409, "conflict"))
			return
		}
		ctx := context.WithValue(r.Context(), platformCourierBindingKey{}, platformCourierBinding{OwnerRef: actor, Version: bound.Version})
		courier, err := s.couriers.SetAvailability(ctx, bound.ID, input.Availability)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, platformStaffCourier{courier.ID, courier.Name, courier.Active, courier.Availability})
	}))
}
