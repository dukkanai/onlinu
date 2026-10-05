package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const metaDefaultAPIVersion = "v24.0"

var (
	metaDigits  = regexp.MustCompile(`^[0-9]{1,32}$`)
	metaVersion = regexp.MustCompile(`^v[0-9]{1,3}\.0$`)
)

type metaSDP struct {
	Type string `json:"sdp_type"`
	SDP  string `json:"sdp"`
}

type metaCallRequest struct {
	Action  string   `json:"action"`
	CallID  string   `json:"call_id,omitempty"`
	To      string   `json:"to,omitempty"`
	Session *metaSDP `json:"session,omitempty"`
}

type metaPermissionResult struct {
	Status    string `json:"status"`
	CanCall   bool   `json:"canCall"`
	ExpiresAt int64  `json:"expiresAt"`
}

type metaGraphClient struct {
	baseURL    string
	httpClient *http.Client
}

// Meta response bodies may contain phone numbers, SDP, or credentials. Never
// include the response body, request URL, or underlying transport error here.
type metaGraphError struct {
	StatusCode int
	Code       int
}

func (e *metaGraphError) Error() string {
	if e.Code != 0 {
		return fmt.Sprintf("Meta request failed (HTTP %d, code %d)", e.StatusCode, e.Code)
	}
	return fmt.Sprintf("Meta request failed (HTTP %d)", e.StatusCode)
}

func (g *metaGraphClient) request(ctx context.Context, cfg metaConfig, method, path string, query url.Values, body any, result any) error {
	if !metaVersion.MatchString(cfg.APIVersion) || cfg.AccessToken == "" {
		return errors.New("Meta API credentials are not configured")
	}
	base := strings.TrimRight(g.baseURL, "/")
	if base == "" {
		base = "https://graph.facebook.com"
	}
	endpoint := base + "/" + cfg.APIVersion + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return errors.New("invalid Meta request")
		}
		reader = bytes.NewReader(encoded)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return errors.New("invalid Meta endpoint")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AccessToken)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := g.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	// Do not forward business credentials through redirects, even when a test
	// client or the default transport has permissive redirect handling.
	safeClient := *client
	safeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := safeClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("Meta request timed out or was cancelled")
		}
		return errors.New("Meta network request failed")
	}
	defer resp.Body.Close()
	const maxBody = 2 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil || len(data) > maxBody {
		return errors.New("invalid Meta response")
	}
	var failure struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &failure)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || failure.Error != nil {
		graphErr := &metaGraphError{StatusCode: resp.StatusCode}
		if failure.Error != nil {
			graphErr.Code = failure.Error.Code
		}
		return graphErr
	}
	if result != nil && json.Unmarshal(data, result) != nil {
		return errors.New("invalid Meta response")
	}
	return nil
}

func (g *metaGraphClient) Call(ctx context.Context, cfg metaConfig, input metaCallRequest) (string, error) {
	if !metaDigits.MatchString(cfg.PhoneNumberID) {
		return "", errors.New("invalid Meta phone number ID")
	}
	switch input.Action {
	case "connect":
		if !metaDigits.MatchString(input.To) || input.CallID != "" || input.Session == nil || input.Session.Type != "offer" || input.Session.SDP == "" {
			return "", errors.New("invalid Meta connect request")
		}
	case "pre_accept", "accept":
		if input.CallID == "" || input.Session == nil || input.Session.Type != "answer" || input.Session.SDP == "" {
			return "", errors.New("invalid Meta accept request")
		}
	case "reject", "terminate":
		if input.CallID == "" || input.Session != nil {
			return "", errors.New("invalid Meta end request")
		}
	default:
		return "", errors.New("unsupported Meta call action")
	}
	if input.Session != nil && len(input.Session.SDP) > 256*1024 {
		return "", errors.New("Meta SDP is too large")
	}
	body := struct {
		MessagingProduct string `json:"messaging_product"`
		metaCallRequest
	}{"whatsapp", input}
	var response struct {
		Calls []struct {
			ID string `json:"id"`
		} `json:"calls"`
		Success *bool `json:"success"`
	}
	if err := g.request(ctx, cfg, http.MethodPost, "/"+cfg.PhoneNumberID+"/calls", nil, body, &response); err != nil {
		return "", err
	}
	if response.Success != nil && !*response.Success {
		return "", errors.New("Meta call action was not accepted")
	}
	if input.Action == "connect" {
		if len(response.Calls) != 1 || response.Calls[0].ID == "" {
			return "", errors.New("Meta did not return a call ID")
		}
		return response.Calls[0].ID, nil
	}
	if response.Success == nil || !*response.Success {
		return "", errors.New("Meta did not confirm the call action")
	}
	return input.CallID, nil
}

func (g *metaGraphClient) Permissions(ctx context.Context, cfg metaConfig, phone string) (metaPermissionResult, error) {
	var out metaPermissionResult
	if !metaDigits.MatchString(cfg.PhoneNumberID) || !metaDigits.MatchString(phone) {
		return out, metaInvalid("WhatsApp phone number must contain only international-format digits")
	}
	var response struct {
		Permission struct {
			Status     string `json:"status"`
			Expiration int64  `json:"expiration_time"`
		} `json:"permission"`
		Actions []struct {
			Name    string `json:"action_name"`
			Allowed bool   `json:"can_perform_action"`
		} `json:"actions"`
	}
	if err := g.request(ctx, cfg, http.MethodGet, "/"+cfg.PhoneNumberID+"/call_permissions", url.Values{"user_wa_id": {phone}}, nil, &response); err != nil {
		return out, err
	}
	out.Status = response.Permission.Status
	out.ExpiresAt = response.Permission.Expiration
	for _, action := range response.Actions {
		if action.Name == "start_call" {
			out.CanCall = action.Allowed
			break
		}
	}
	return out, nil
}

func (g *metaGraphClient) RequestPermission(ctx context.Context, cfg metaConfig, phone string) error {
	if !metaDigits.MatchString(cfg.PhoneNumberID) || !metaDigits.MatchString(phone) {
		return metaInvalid("WhatsApp phone number must contain only international-format digits")
	}
	body := map[string]any{
		"messaging_product": "whatsapp", "recipient_type": "individual", "to": phone, "type": "interactive",
		"interactive": map[string]any{
			"type":   "call_permission_request",
			"action": map[string]string{"name": "call_permission_request"},
			"body":   map[string]string{"text": "May we call you on WhatsApp?"},
		},
	}
	var response struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := g.request(ctx, cfg, http.MethodPost, "/"+cfg.PhoneNumberID+"/messages", nil, body, &response); err != nil {
		return err
	}
	if len(response.Messages) == 0 || response.Messages[0].ID == "" {
		return errors.New("Meta did not confirm the permission request")
	}
	return nil
}

// Verify does not change Meta account settings or subscribe an app. It checks
// ownership and whether this account is configured for Graph/WebRTC calling.
func (g *metaGraphClient) Verify(ctx context.Context, cfg metaConfig) (callingEnabled, sipEnabled bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if !metaDigits.MatchString(cfg.PhoneNumberID) || !metaDigits.MatchString(cfg.WABAID) {
		return false, false, errors.New("invalid Meta account IDs")
	}
	var phone struct {
		ID string `json:"id"`
	}
	if err = g.request(ctx, cfg, http.MethodGet, "/"+cfg.PhoneNumberID, url.Values{"fields": {"id"}}, nil, &phone); err != nil {
		return
	}
	if phone.ID != cfg.PhoneNumberID {
		err = errors.New("Meta phone number could not be verified")
		return
	}
	// Follow only opaque cursors on our fixed Graph origin; never paging.next,
	// which can carry access tokens or point at an untrusted URL.
	cursor := ""
	owned := false
	for page := 0; page < 100; page++ {
		var phones struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
			Paging struct {
				Cursors struct {
					After string `json:"after"`
				} `json:"cursors"`
				Next string `json:"next"`
			} `json:"paging"`
		}
		query := url.Values{"fields": {"id"}, "limit": {"100"}}
		if cursor != "" {
			query.Set("after", cursor)
		}
		if err = g.request(ctx, cfg, http.MethodGet, "/"+cfg.WABAID+"/phone_numbers", query, nil, &phones); err != nil {
			return
		}
		for _, candidate := range phones.Data {
			if candidate.ID == cfg.PhoneNumberID {
				owned = true
				break
			}
		}
		if owned || phones.Paging.Next == "" || phones.Paging.Cursors.After == "" {
			break
		}
		if cursor == phones.Paging.Cursors.After {
			err = errors.New("invalid Meta pagination response")
			return
		}
		cursor = phones.Paging.Cursors.After
	}
	if !owned {
		err = errors.New("phone number does not belong to the configured WhatsApp Business account")
		return
	}
	var settings struct {
		Calling struct {
			Status string `json:"status"`
			SIP    struct {
				Status string `json:"status"`
			} `json:"sip"`
		} `json:"calling"`
	}
	if err = g.request(ctx, cfg, http.MethodGet, "/"+cfg.PhoneNumberID+"/settings", nil, nil, &settings); err != nil {
		return
	}
	callingEnabled = strings.EqualFold(settings.Calling.Status, "enabled")
	// Unknown/missing SIP state is safe only when SIP is not configured; an
	// explicit status other than DISABLED must not enable Graph calling.
	sipEnabled = settings.Calling.SIP.Status != "" && !strings.EqualFold(settings.Calling.SIP.Status, "disabled")
	return
}
