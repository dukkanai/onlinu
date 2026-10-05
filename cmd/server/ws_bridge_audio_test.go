//go:build mlow

package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"wacalls/internal/voip/media"
)

// Regression: the 512-sample browser buffer is not a legal Opus frame size.
func TestWSBridgeReframesBrowserAudio(t *testing.T) {
	frames := make(chan []byte, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		bridge := newWSBridge(conn, slog.Default())
		defer bridge.Close()
		codec, err := media.NewOpusCodec(48000, 960)
		if err != nil {
			t.Error(err)
			return
		}
		defer codec.Close()
		bridge.OnBrowserRTP = func(opus []byte) { frames <- opus }
		bridge.readLoop(codec)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	// Five capture chunks contain exactly eight 20ms frames.
	for range 5 {
		if err := conn.Write(ctx, websocket.MessageBinary, make([]byte, 512*2)); err != nil {
			t.Fatal(err)
		}
	}
	for range 8 {
		select {
		case frame := <-frames:
			if len(frame) == 0 {
				t.Fatal("empty encoded frame")
			}
		case <-ctx.Done():
			t.Fatal("browser PCM was not delivered as valid Opus frames")
		}
	}
}
