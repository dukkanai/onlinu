package main

import (
	"bytes"
	"io"
	"net/http"
)

type restaurantOrderChannelView struct {
	restaurantOrderChannelPolicy
	AdapterImplemented bool `json:"adapterImplemented"`
}

func restaurantChannelView(policy restaurantOrderChannelPolicy) restaurantOrderChannelView {
	return restaurantOrderChannelView{policy, policy.Channel == "web" || policy.Channel == "chatgpt"}
}

func (s *server) handleOrderChannels(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeRestaurantError(w, restaurantFail(400, "invalid_request"))
		return
	}
	policies, err := s.orders.OrderChannels(r.Context())
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	result := make([]restaurantOrderChannelView, 0, len(policies))
	for _, policy := range policies {
		result = append(result, restaurantChannelView(policy))
	}
	writeJSON(w, 200, map[string]any{"channels": result})
}

func (s *server) handleSetOrderChannel(w http.ResponseWriter, r *http.Request, actor string) {
	if r.URL.RawQuery != "" {
		writeRestaurantError(w, restaurantFail(400, "invalid_request"))
		return
	}
	var input struct {
		NewOrdersEnabled *bool `json:"newOrdersEnabled"`
		ExpectedVersion  int64 `json:"expectedVersion"`
	}
	if !decodeRestaurantBody(w, r, &input) {
		return
	}
	if input.NewOrdersEnabled == nil {
		writeRestaurantError(w, restaurantFail(400, "invalid_request"))
		return
	}
	policy, err := s.orders.SetOrderChannel(r.Context(), r.PathValue("channel"), actor, *input.NewOrdersEnabled, input.ExpectedVersion)
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	writeJSON(w, 200, restaurantChannelView(policy))
}

func (s *server) registerPlatformChannelRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/channels", wrap("staff:channels:manage", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) { s.handleOrderChannels(w, r) }))
	mux.HandleFunc("POST /platform-api/staff/channels/{channel}", wrap("staff:channels:manage", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		r.Body = io.NopCloser(bytes.NewReader(body))
		s.handleSetOrderChannel(w, r, actor)
	}))
}
