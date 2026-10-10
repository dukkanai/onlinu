package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

var restaurantImageName = regexp.MustCompile(`^[a-f0-9]{64}\.(jpg|png)$`)
var restaurantImageSlots = make(chan struct{}, 2)

const restaurantImageLimit = 5 << 20

func restaurantMediaDir() string {
	return filepath.Join(envStr("WACALLS_MEDIA_DIR", envStr("WACALLS_RECORDING_DIR", "recordings")), "restaurant-images")
}

func (s *server) handleRestaurantImageUpload(w http.ResponseWriter, r *http.Request) {
	select {
	case restaurantImageSlots <- struct{}{}:
		defer func() { <-restaurantImageSlots }()
	default:
		writeRestaurantError(w, restaurantFail(429, "rate_limited"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, restaurantImageLimit+(1<<16))
	if err := r.ParseMultipartForm(restaurantImageLimit); err != nil {
		writeRestaurantError(w, restaurantFail(400, "image_too_large"))
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, _, err := r.FormFile("image")
	if err != nil {
		writeRestaurantError(w, restaurantFail(400, "image_invalid"))
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, restaurantImageLimit+1))
	if err != nil || len(raw) > restaurantImageLimit {
		writeRestaurantError(w, restaurantFail(400, "image_too_large"))
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png") || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 || int64(config.Width)*int64(config.Height) > 16000000 {
		writeRestaurantError(w, restaurantFail(400, "image_invalid"))
		return
	}
	picture, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		writeRestaurantError(w, restaurantFail(400, "image_invalid"))
		return
	}
	// Re-encode: removes EXIF coordinates/metadata and any appended active content.
	var output bytes.Buffer
	extension := ".jpg"
	if format == "png" {
		extension = ".png"
		err = png.Encode(&output, picture)
	} else {
		err = jpeg.Encode(&output, picture, &jpeg.Options{Quality: 88})
	}
	if err != nil {
		writeRestaurantError(w, restaurantFail(400, "image_invalid"))
		return
	}
	if output.Len() > restaurantImageLimit {
		writeRestaurantError(w, restaurantFail(400, "image_too_large"))
		return
	}
	digest := sha256.Sum256(output.Bytes())
	name := hex.EncodeToString(digest[:]) + extension
	if err = os.MkdirAll(restaurantMediaDir(), 0750); err != nil {
		writeRestaurantError(w, err)
		return
	}
	destination := filepath.Join(restaurantMediaDir(), name)
	// Publish only a complete normalized image. Identical concurrent uploads
	// may replace the same content hash atomically, never expose partial data.
	f, err := os.CreateTemp(restaurantMediaDir(), ".upload-")
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(output.Bytes())
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		writeRestaurantError(w, restaurantFail(500, "server_error"))
		return
	}
	if err = os.Chmod(f.Name(), 0640); err == nil {
		err = os.Rename(f.Name(), destination)
	}
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"url": "/restaurant-media/" + name})
}

func (s *server) handleRestaurantImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !restaurantImageName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	file, info, err := restaurantOpenPublicFile(restaurantMediaDir(), name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, name, info.ModTime(), file)
}
