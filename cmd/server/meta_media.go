package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// The official provider is a separate, audio-only WebRTC leg. Browser Opus is
// relayed directly; neither WhatsMeow nor its 16 kHz codec path is involved.
type metaMedia struct {
	pc               *webrtc.PeerConnection
	track            *webrtc.TrackLocalStaticSample
	connected        chan struct{}
	connect          sync.Once
	closed           chan struct{}
	closeOnce        sync.Once
	enabled          atomic.Bool
	browserConnected atomic.Bool
	frames           chan []byte
	mu               sync.RWMutex
	bridge           *Bridge
	onFailure        func()
}

func newMetaMedia(log *slog.Logger, onFailure func()) (*metaMedia, error) {
	pc, err := getBrowserAPI(log).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, errors.New("could not initialize official call media")
	}
	m := &metaMedia{pc: pc, connected: make(chan struct{}), closed: make(chan struct{}), frames: make(chan []byte, 5), onFailure: onFailure}
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		SDPFmtpLine: "minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0",
	}, "audio", "astracalls-meta")
	if err != nil {
		_ = pc.Close()
		return nil, errors.New("could not initialize official audio track")
	}
	m.track = track
	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return nil, errors.New("could not attach official audio track")
	}
	for _, transceiver := range pc.GetTransceivers() {
		if transceiver.Sender() == sender {
			if err = transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0"}, PayloadType: 111}}); err != nil {
				_ = pc.Close()
				return nil, errors.New("could not select official Opus codec")
			}
		}
	}
	// Drain RTCP so sender interceptors do not stall on a full feedback queue.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			m.connect.Do(func() { close(m.connected) })
		}
		if state == webrtc.PeerConnectionStateFailed {
			if m.onFailure != nil {
				go m.onFailure()
			}
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
			return
		}
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if !m.enabled.Load() {
				continue
			}
			m.mu.RLock()
			bridge := m.bridge
			m.mu.RUnlock()
			if duration := opusPacketDuration(packet.Payload); bridge != nil && duration > 0 {
				_ = bridge.WriteOpus(packet.Payload, duration)
			}
		}
	})
	go m.sendAudio()
	return m, nil
}

// A clocked source emits Opus silence even before the remote party sends RTP.
// Waiting for inbound audio would deadlock with a peer that also waits first.
// Audio is enabled only after the inbound accept request has succeeded.
func (m *metaMedia) sendAudio() {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.closed:
			return
		case <-ticker.C:
			if !m.enabled.Load() {
				continue
			}
			select {
			case <-m.connected:
			default:
				continue
			}
			frame := []byte{0xf8, 0xff, 0xfe} // Standard 20 ms Opus silence packet.
			select {
			case frame = <-m.frames:
			default:
			}
			_ = m.track.WriteSample(media.Sample{Data: frame, Duration: 20 * time.Millisecond})
		}
	}
}

func (m *metaMedia) offer(ctx context.Context) (string, error) {
	offer, err := m.pc.CreateOffer(nil)
	if err != nil {
		return "", errors.New("could not create official media offer")
	}
	sdp, err := metaGather(ctx, m.pc, offer)
	if err != nil {
		return "", err
	}
	return metaAudioSDP(sdp), nil
}

func (m *metaMedia) answer(ctx context.Context, offer string) (string, error) {
	if !metaAudioOnlySDP(offer) {
		return "", errors.New("official calls require audio-only Opus SDP")
	}
	if err := m.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return "", errors.New("invalid official media offer")
	}
	answer, err := m.pc.CreateAnswer(nil)
	if err != nil {
		return "", errors.New("could not create official media answer")
	}
	sdp, err := metaGather(ctx, m.pc, answer)
	if err != nil {
		return "", err
	}
	return metaAudioSDP(sdp), nil
}

func (m *metaMedia) remoteAnswer(answer string) error {
	if !metaAudioOnlySDP(answer) {
		return errors.New("official calls require audio-only Opus SDP")
	}
	if err := m.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		return errors.New("invalid official media answer")
	}
	return nil
}

func metaGather(ctx context.Context, pc *webrtc.PeerConnection, description webrtc.SessionDescription) (string, error) {
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(description); err != nil {
		return "", errors.New("could not negotiate audio media")
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-deadline.C:
		return "", errors.New("audio candidate gathering timed out")
	case <-gathered:
		if local := pc.LocalDescription(); local != nil {
			return local.SDP, nil
		}
		return "", errors.New("audio media was closed")
	}
}

func metaAudioOnlySDP(sdp string) bool {
	return metaAudioSDPTracks(sdp, 1, false)
}

func metaAudioSDPTracks(sdp string, maxTracks int, allowData bool) bool {
	if len(sdp) == 0 || len(sdp) > 256*1024 {
		return false
	}
	audio := 0
	data := 0
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "m=") {
			if allowData && strings.HasPrefix(line, "m=application ") {
				data++
				if data > 1 {
					return false
				}
				continue
			}
			if !strings.HasPrefix(line, "m=audio ") {
				return false
			}
			audio++
		}
	}
	return audio > 0 && audio <= maxTracks && strings.Contains(strings.ToLower(sdp), "opus/48000")
}

func metaAudioSDP(sdp string) string {
	lines := strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines)+2)
	inAudio := false
	for _, line := range lines {
		if line == "" || strings.HasPrefix(line, "a=ptime:") || strings.HasPrefix(line, "a=maxptime:") {
			continue
		}
		if strings.HasPrefix(line, "m=") {
			if inAudio {
				out = append(out, "a=ptime:20", "a=maxptime:20")
			}
			inAudio = strings.HasPrefix(line, "m=audio ")
		}
		out = append(out, line)
	}
	if inAudio {
		out = append(out, "a=ptime:20", "a=maxptime:20")
	}
	return strings.Join(out, "\r\n") + "\r\n"
}

// RFC 6716 section 3.1: duration encoded in the Opus TOC. No native decoder is
// necessary for timing passthrough packets. Invalid packets are never relayed.
func opusPacketDuration(packet []byte) time.Duration {
	if len(packet) == 0 {
		return 0
	}
	config := packet[0] >> 3
	var frame time.Duration
	switch {
	case config >= 16:
		frame = (2500 * time.Microsecond) << (config & 3)
	case config >= 12:
		frame = (10 * time.Millisecond) << (config & 1)
	case config&3 == 3:
		frame = 60 * time.Millisecond
	default:
		frame = (10 * time.Millisecond) << (config & 3)
	}
	count := 1
	switch packet[0] & 3 {
	case 1, 2:
		count = 2
	case 3:
		if len(packet) < 2 {
			return 0
		}
		count = int(packet[1] & 0x3f)
	}
	duration := frame * time.Duration(count)
	if duration > 120*time.Millisecond {
		return 0
	}
	return duration
}

func (m *metaMedia) browser(ctx context.Context, offer string, log *slog.Logger) (string, error) {
	// Existing browser negotiation uses sendrecv plus a separate recvonly audio
	// transceiver. Both are audio; only the Meta-facing leg must have one m-line.
	if !metaAudioSDPTracks(offer, 2, true) {
		return "", errors.New("official calls support audio-only WebRTC")
	}
	pc, err := getBrowserAPI(log).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", errors.New("could not initialize browser audio")
	}
	bridge := &Bridge{pc: pc, log: log}
	success := false
	defer func() {
		if !success {
			bridge.DisableTerminate()
			bridge.Close()
		}
	}()
	bridge.localTrack, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		SDPFmtpLine: "minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0",
	}, "audio", "astracalls")
	if err != nil {
		return "", errors.New("could not initialize browser audio track")
	}
	bridge.OnBrowserRTP = func(packet []byte) {
		// Our SDP requests 20 ms. Do not silently re-clock larger packets.
		if opusPacketDuration(packet) != 20*time.Millisecond || !m.enabled.Load() {
			return
		}
		copyPacket := append([]byte(nil), packet...)
		select {
		case m.frames <- copyPacket:
		default:
		}
	}
	bridge.OnTerminalICE = func() {
		if m.onFailure != nil {
			go m.onFailure()
		}
	}
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		if (state == webrtc.ICEConnectionStateFailed || state == webrtc.ICEConnectionStateClosed) && !bridge.terminateDisabled.Load() {
			bridge.OnTerminalICE()
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
			return
		}
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			bridge.OnBrowserRTP(packet.Payload)
		}
	})
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return "", errors.New("invalid browser audio offer")
	}
	for _, transceiver := range pc.GetTransceivers() {
		if transceiver.Kind() == webrtc.RTPCodecTypeAudio {
			if err = transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0"}, PayloadType: 111}}); err != nil {
				return "", errors.New("could not select browser Opus codec")
			}
		}
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			m.browserConnected.Store(true)
		}
	})
	sender, err := pc.AddTrack(bridge.localTrack)
	if err != nil {
		return "", errors.New("could not attach browser audio track")
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", errors.New("could not answer browser audio offer")
	}
	sdp, err := metaGather(ctx, pc, answer)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	select {
	case <-m.closed:
		m.mu.Unlock()
		return "", errors.New("official call has ended")
	default:
	}
	old := m.bridge
	m.bridge = bridge
	m.mu.Unlock()
	if old != nil {
		old.DisableTerminate()
		old.Close()
	}
	success = true
	return metaAudioSDP(sdp), nil
}

func (m *metaMedia) Close() {
	m.closeOnce.Do(func() {
		close(m.closed)
		m.mu.Lock()
		bridge := m.bridge
		m.bridge = nil
		m.mu.Unlock()
		if bridge != nil {
			bridge.DisableTerminate()
			bridge.Close()
		}
		_ = m.pc.Close()
	})
}
