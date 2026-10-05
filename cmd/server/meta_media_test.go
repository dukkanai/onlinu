package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	audiocodec "wacalls/internal/voip/media"
)

func TestMetaOpusPacketDuration(t *testing.T) {
	for _, test := range []struct {
		packet []byte
		want   time.Duration
	}{
		{nil, 0}, {[]byte{0xf8, 0xff, 0xfe}, 20 * time.Millisecond}, {[]byte{0x98}, 20 * time.Millisecond},
		{[]byte{0x80}, 2500 * time.Microsecond}, {[]byte{0x83}, 0}, {[]byte{0xfb, 63}, 0},
		{[]byte{0xf9}, 40 * time.Millisecond}, {[]byte{0xfb, 3}, 60 * time.Millisecond},
	} {
		if got := opusPacketDuration(test.packet); got != test.want {
			t.Errorf("duration(%x)=%v, want %v", test.packet, got, test.want)
		}
	}
}

func TestMetaMediaAcceptsActualBrowserShape(t *testing.T) {
	remote := metaTestRemote(t, false, false)
	if _, err := remote.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.CreateDataChannel("h264", nil); err != nil {
		t.Fatal(err)
	}
	offer := metaTestOffer(t, remote)
	if strings.Count(offer, "m=audio ") != 2 || !strings.Contains(offer, "m=application ") {
		t.Fatal("test does not represent browser SDP")
	}
	if metaAudioOnlySDP(offer) {
		t.Fatal("Meta leg must reject browser's multiple tracks/data channel")
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m, err := newMetaMedia(log, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	answer, err := m.browser(ctx, offer, log)
	if err != nil {
		t.Fatal(err)
	}
	if err = remote.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(answer, "a=ptime:20") != 2 {
		t.Fatal("20ms browser packet time not negotiated")
	}
	if _, err = m.browser(ctx, strings.Replace(offer, "m=audio ", "m=video ", 1), log); err == nil {
		t.Fatal("video offer accepted")
	}
}

func TestMetaMediaOfferOpusOnly(t *testing.T) {
	m, err := newMetaMedia(slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	offer, err := m.offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(offer, "PCMU") || strings.Contains(offer, "G722") || strings.Contains(offer, "m=video") {
		t.Fatal("official offer includes unsupported codecs/media")
	}
	if !metaAudioOnlySDP(offer) || !strings.Contains(offer, "a=ptime:20") || !strings.Contains(offer, "a=maxptime:20") {
		t.Fatal("official offer must be Opus 48kHz, 20ms audio")
	}
}

func TestMetaMediaBidirectionalOpusPassthrough(t *testing.T) {
	codec, err := audiocodec.NewOpusCodec(48000, 960)
	if err != nil {
		t.Skip("native Opus encoder unavailable in this build")
	}
	defer codec.Close()
	makePacket := func(frequency float64) []byte {
		pcm := make([]float32, 960)
		for i := range pcm {
			pcm[i] = float32(0.2 * math.Sin(float64(i)*2*math.Pi*frequency/48000))
		}
		packet, err := codec.Encode(pcm)
		if err != nil {
			t.Fatal(err)
		}
		return packet
	}
	fromBrowser, fromMeta := makePacket(440), makePacket(880)
	if bytes.Equal(fromBrowser, fromMeta) {
		t.Fatal("audio fixtures must differ")
	}
	metaRemote := metaTestRemote(t, false, true)
	browser := metaTestRemote(t, false, false)
	metaReceived, browserReceived := make(chan struct{}, 1), make(chan struct{}, 1)
	metaRemote.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			p, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if bytes.Equal(p.Payload, fromBrowser) {
				select {
				case metaReceived <- struct{}{}:
				default:
				}
				return
			}
		}
	})
	browser.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			p, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if bytes.Equal(p.Payload, fromMeta) {
				select {
				case browserReceived <- struct{}{}:
				default:
				}
				return
			}
		}
	})
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m, err := newMetaMedia(log, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	answer, err := m.answer(ctx, metaTestOffer(t, metaRemote))
	if err != nil {
		t.Fatal(err)
	}
	if err = metaRemote.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	answer, err = m.browser(ctx, metaTestOffer(t, browser), log)
	if err != nil {
		t.Fatal(err)
	}
	if err = browser.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	m.enabled.Store(true)
	metaTrack := metaRemote.GetSenders()[0].Track().(*webrtc.TrackLocalStaticSample)
	browserTrack := browser.GetSenders()[0].Track().(*webrtc.TrackLocalStaticSample)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	gotMeta, gotBrowser := false, false
	for !gotMeta || !gotBrowser {
		select {
		case <-ctx.Done():
			t.Fatalf("two-way audio timed out (to Meta: %v, to browser: %v)", gotMeta, gotBrowser)
		case <-metaReceived:
			gotMeta = true
		case <-browserReceived:
			gotBrowser = true
		case <-ticker.C:
			_ = metaTrack.WriteSample(media.Sample{Data: fromMeta, Duration: 20 * time.Millisecond})
			_ = browserTrack.WriteSample(media.Sample{Data: fromBrowser, Duration: 20 * time.Millisecond})
		}
	}
}
