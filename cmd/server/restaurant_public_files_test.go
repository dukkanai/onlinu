package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// This fixture uses the actual route tree without opening a server
// socket or database. Every file and symlink target is owned by this test.
func publicFileContainmentFixture(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	root := t.TempDir()
	static := filepath.Join(root, "static")
	for _, path := range []string{static, filepath.Join(root, "media", "restaurant-images"), filepath.Join(root, "outside")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	publicFileContainmentWrite(t, filepath.Join(static, "index.html"), []byte("SYNTHETIC-PUBLIC-SPA"))
	t.Setenv("WACALLS_MEDIA_DIR", filepath.Join(root, "media"))
	t.Setenv("WACALLS_API_KEY", "synthetic-containment-admin")
	t.Setenv("WACALLS_PUBLIC_BASE_URL", "https://restaurant.example")
	s := &server{staticDir: static, restaurant: &restaurantStore{}, orders: &restaurantOrders{}, customers: &restaurantAccounts{}}
	return s.routes(), root, static
}

func publicFileContainmentWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func publicFileContainmentRequest(h http.Handler, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, "https://restaurant.example"+path, nil))
	return w
}

func publicFileContainmentUpload(t *testing.T, h http.Handler) string {
	t.Helper()
	pic := image.NewRGBA(image.Rect(0, 0, 3, 3))
	pic.Set(1, 1, color.RGBA{R: 255, A: 255})
	var picture, body bytes.Buffer
	if err := png.Encode(&picture, pic); err != nil {
		t.Fatal(err)
	}
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("image", "synthetic.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(picture.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err = mw.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://restaurant.example/api/restaurant/images", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("Origin", "https://restaurant.example")
	r.Header.Set("X-API-Key", "synthetic-containment-admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("normal image upload: status=%d body=%s", w.Code, w.Body.String())
	}
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !restaurantImageName.MatchString(strings.TrimPrefix(result["url"], "/restaurant-media/")) {
		t.Fatal("invalid fixture image URL")
	}
	return result["url"]
}

func TestPublicFileContainmentPositiveControls(t *testing.T) {
	h, root, static := publicFileContainmentFixture(t)
	imageURL := publicFileContainmentUpload(t, h)
	w := publicFileContainmentRequest(h, http.MethodGet, imageURL)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("normal image failed: %d %v", w.Code, w.Header())
	}
	if _, err := png.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
		t.Fatalf("normal image response: %v", err)
	}
	publicFileContainmentWrite(t, filepath.Join(static, "app.js"), []byte("/* SYNTHETIC-PUBLIC-JS */"))
	for _, path := range []string{"/", "/order", "/track", "/account", "/admin", "/courier", "/payment-return", "/app.js"} {
		w := publicFileContainmentRequest(h, http.MethodGet, path)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "SYNTHETIC-PUBLIC") {
			t.Fatalf("normal static %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	marker := []byte("SYNTHETIC-OUTSIDE-LEXICAL-CONTROL")
	publicFileContainmentWrite(t, filepath.Join(root, "outside", "marker.txt"), marker)
	for _, path := range []string{"/.env", "/missing.js", "/restaurant-media/.env", "/restaurant-media/%2e%2e%2foutside%2fmarker.txt", "/%2e%2e/outside/marker.txt"} {
		w := publicFileContainmentRequest(h, http.MethodGet, path)
		if w.Code != 404 || bytes.Contains(w.Body.Bytes(), marker) {
			t.Fatalf("lexical control %s: %d", path, w.Code)
		}
	}
	t.Log("Actual authenticated image upload and unauthenticated image/static GETs passed; ordinary lexical escapes were refused.")
}

// These refusal cases exposed outside markers before descriptor-based serving.
func TestPublicFileContainmentOutsideSymlinks(t *testing.T) {
	for _, kind := range []string{"media-relative-file", "media-absolute-file", "static-relative-file", "static-directory-component", "spa-index"} {
		t.Run(kind, func(t *testing.T) {
			h, root, static := publicFileContainmentFixture(t)
			marker := []byte("SYNTHETIC-OUTSIDE-MARKER-" + kind)
			outside := filepath.Join(root, "outside", "marker.txt")
			publicFileContainmentWrite(t, outside, marker)
			var link, target, request string
			switch kind {
			case "media-relative-file", "media-absolute-file":
				name := strings.Repeat("a", 64) + ".png"
				link, target, request = filepath.Join(root, "media", "restaurant-images", name), "../../outside/marker.txt", "/restaurant-media/"+name
				if kind == "media-absolute-file" {
					target = outside
				}
			case "static-relative-file":
				link, target, request = filepath.Join(static, "asset.txt"), "../outside/marker.txt", "/asset.txt"
			case "static-directory-component":
				link, target, request = filepath.Join(static, "assets"), "../outside", "/assets/marker.txt"
			case "spa-index":
				link, target, request = filepath.Join(static, "index.html"), "../outside/marker.txt", "/order"
				if err := os.Remove(link); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			w := publicFileContainmentRequest(h, http.MethodGet, request)
			exposed := bytes.Equal(w.Body.Bytes(), marker)
			t.Logf("unauthenticated GET %s: status=%d markerExposed=%t contentType=%q cacheControl=%q", request, w.Code, exposed, w.Header().Get("Content-Type"), w.Header().Get("Cache-Control"))
			if w.Code != http.StatusNotFound || exposed {
				t.Errorf("outside-root symlink must be refused with 404; status=%d markerExposed=%t", w.Code, exposed)
			}
		})
	}
}

func TestPublicFileContainmentUploadReplacesSymlink(t *testing.T) {
	h, root, _ := publicFileContainmentFixture(t)
	imageURL := publicFileContainmentUpload(t, h)
	name := strings.TrimPrefix(imageURL, "/restaurant-media/")
	link := filepath.Join(root, "media", "restaurant-images", name)
	marker := []byte("SYNTHETIC-OUTSIDE-UPLOAD-CONTROL")
	outside := filepath.Join(root, "outside", "marker.txt")
	publicFileContainmentWrite(t, outside, marker)
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if publicFileContainmentUpload(t, h) != imageURL {
		t.Fatal("identical normalized upload changed URL")
	}
	info, err := os.Lstat(link)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("uploaded path remained a symlink: %v %v", info, err)
	}
	got, err := os.ReadFile(outside)
	if err != nil || !bytes.Equal(got, marker) {
		t.Fatal("upload changed outside marker")
	}
	w := publicFileContainmentRequest(h, http.MethodGet, imageURL)
	if w.Code != 200 {
		t.Fatalf("replaced image status=%d", w.Code)
	}
	if _, err := png.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
	t.Log("Identical normalized upload atomically replaced the owned planted link with a regular image; its outside target was unchanged.")
}

func TestPublicFileContainmentHiddenAliases(t *testing.T) {
	for _, kind := range []string{"hidden-leaf", "hidden-directory"} {
		t.Run(kind, func(t *testing.T) {
			h, _, static := publicFileContainmentFixture(t)
			marker := []byte("SYNTHETIC-IN-ROOT-HIDDEN-MARKER-" + kind)
			var hidden, link, target, request, hiddenRequest string
			if kind == "hidden-leaf" {
				hidden, link, target, request, hiddenRequest = filepath.Join(static, ".fixture-private"), filepath.Join(static, "public.txt"), ".fixture-private", "/public.txt", "/.fixture-private"
			} else {
				if err := os.Mkdir(filepath.Join(static, ".fixture-private"), 0700); err != nil {
					t.Fatal(err)
				}
				hidden, link, target, request, hiddenRequest = filepath.Join(static, ".fixture-private", "marker.txt"), filepath.Join(static, "public"), ".fixture-private", "/public/marker.txt", "/.fixture-private/marker.txt"
			}
			publicFileContainmentWrite(t, hidden, marker)
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			direct := publicFileContainmentRequest(h, http.MethodGet, hiddenRequest)
			if direct.Code != http.StatusNotFound {
				t.Fatalf("direct hidden path status=%d", direct.Code)
			}
			root, err := os.OpenRoot(static)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			rootBytes, err := root.ReadFile(strings.TrimPrefix(request, "/"))
			if err != nil || !bytes.Equal(rootBytes, marker) {
				t.Fatalf("os.Root alias control: %v", err)
			}
			w := publicFileContainmentRequest(h, http.MethodGet, request)
			exposed := bytes.Equal(w.Body.Bytes(), marker)
			t.Logf("direct hidden GET status=%d; alias GET %s: status=%d markerExposed=%t; os.Root alone also follows the in-root alias", direct.Code, request, w.Code, exposed)
			if w.Code != http.StatusNotFound || exposed {
				t.Errorf("alias to a path forbidden by static policy must be refused; status=%d markerExposed=%t", w.Code, exposed)
			}
		})
	}
}

func TestPublicFileContainmentRootBoundaryControls(t *testing.T) {
	_, rootPath, static := publicFileContainmentFixture(t)
	marker := []byte("SYNTHETIC-ROOT-BOUNDARY-CONTROL")
	publicFileContainmentWrite(t, filepath.Join(rootPath, "outside", "marker.txt"), marker)
	if err := os.Symlink("../outside/marker.txt", filepath.Join(static, "file-link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside", filepath.Join(static, "dir-link")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(static)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, name := range []string{"file-link.txt", "dir-link/marker.txt"} {
		if data, err := root.ReadFile(name); err == nil || bytes.Contains(data, marker) {
			t.Fatalf("os.Root must reject %s; err=%v", name, err)
		}
	}
	t.Log("os.Root rejects static leaf and directory-component links outside the actual static root.")
}

func TestPublicFileContainmentStaticAndMediaRefusals(t *testing.T) {
	h, root, static := publicFileContainmentFixture(t)
	publicFileContainmentWrite(t, filepath.Join(static, "regular.txt"), []byte("SYNTHETIC-PUBLIC-REGULAR"))
	for name, target := range map[string]string{
		"internal-link.txt": "regular.txt",
		"dangling.txt":      "missing.txt",
		"loop.txt":          "loop.txt",
	} {
		if err := os.Symlink(target, filepath.Join(static, name)); err != nil {
			t.Fatal(err)
		}
	}
	name := strings.Repeat("b", 64) + ".png"
	if err := os.Mkdir(filepath.Join(root, "media", "restaurant-images", name), 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/internal-link.txt", "/dangling.txt", "/loop.txt", "/restaurant-media/" + name, "/regular.txt/", "/.hidden/regular.txt", "/assets%5c.hidden%5cfixture.txt"} {
		w := publicFileContainmentRequest(h, http.MethodGet, path)
		if w.Code != http.StatusNotFound {
			t.Fatalf("refusal %s: status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/", "/regular.txt", "/api/missing", "/storefront-api/missing", "/courier-api/missing", "/payment-hooks/missing"} {
		w := publicFileContainmentRequest(h, http.MethodPost, path)
		if w.Code != http.StatusNotFound && w.Code != http.StatusMethodNotAllowed && w.Code != http.StatusUnauthorized && w.Code != http.StatusServiceUnavailable {
			t.Fatalf("unexpected static fallback on POST %s: status=%d", path, w.Code)
		}
		if strings.Contains(w.Body.String(), "SYNTHETIC-PUBLIC") {
			t.Fatalf("non-static request %s served a file", path)
		}
	}
}

func TestPublicFileContainmentDifferentInodeSwaps(t *testing.T) {
	for _, kind := range []string{"leaf-outside-link", "leaf-hidden-link", "directory-outside-link", "directory-hidden-link", "leaf-regular-replacement", "directory-regular-replacement"} {
		t.Run(kind, func(t *testing.T) {
			_, owned, static := publicFileContainmentFixture(t)
			for _, dir := range []string{filepath.Join(static, "assets"), filepath.Join(static, ".private")} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			publicFileContainmentWrite(t, filepath.Join(static, "assets", "fixture.txt"), []byte("SYNTHETIC-PUBLIC-BEFORE-SWAP"))
			marker := []byte("SYNTHETIC-PRIVATE-DIFFERENT-INODE")
			publicFileContainmentWrite(t, filepath.Join(static, "assets", ".private.txt"), marker)
			publicFileContainmentWrite(t, filepath.Join(static, ".private", "fixture.txt"), marker)
			publicFileContainmentWrite(t, filepath.Join(owned, "outside", "fixture.txt"), marker)
			base, err := os.OpenRoot(static)
			if err != nil {
				t.Fatal(err)
			}
			defer base.Close()
			swapped := false
			file, _, err := restaurantOpenPublicFileInRoot(base, "assets/fixture.txt", func(component string) {
				directory := strings.HasPrefix(kind, "directory-")
				if swapped || (directory && component != "assets") || (!directory && component != "assets/fixture.txt") {
					return
				}
				swapped = true
				path := filepath.Join(static, filepath.FromSlash(component))
				if err := os.Rename(path, path+".old"); err != nil {
					t.Fatal(err)
				}
				switch kind {
				case "leaf-outside-link":
					err = os.Symlink(filepath.Join(owned, "outside", "fixture.txt"), path)
				case "leaf-hidden-link":
					err = os.Symlink(".private.txt", path)
				case "directory-outside-link":
					err = os.Symlink(filepath.Join(owned, "outside"), path)
				case "directory-hidden-link":
					err = os.Symlink(".private", path)
				case "leaf-regular-replacement":
					err = os.Rename(filepath.Join(static, "assets", ".private.txt"), path)
				case "directory-regular-replacement":
					err = os.Rename(filepath.Join(static, ".private"), path)
				}
				if err != nil {
					t.Fatal(err)
				}
			})
			if file != nil {
				defer file.Close()
				t.Fatal("substituted private object returned an open file")
			}
			if !swapped || err == nil {
				t.Fatalf("different-inode replacement was not refused: swapped=%t err=%v", swapped, err)
			}
			if _, err := base.Stat("."); err != nil {
				t.Fatal("helper closed its caller-owned root")
			}
		})
	}
}

func TestPublicFileContainmentOpenedDescriptorPinned(t *testing.T) {
	_, _, static := publicFileContainmentFixture(t)
	original := []byte("SYNTHETIC-PUBLIC-PINNED-DESCRIPTOR")
	private := []byte("SYNTHETIC-HIDDEN-POST-OPEN-MARKER")
	path := filepath.Join(static, "asset.txt")
	publicFileContainmentWrite(t, path, original)
	publicFileContainmentWrite(t, filepath.Join(static, ".private.txt"), private)
	file, info, err := restaurantOpenPublicFile(static, "asset.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".private.txt", path); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	http.ServeContent(w, httptest.NewRequest(http.MethodGet, "/asset.txt", nil), "asset.txt", info.ModTime(), file)
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), original) || bytes.Contains(w.Body.Bytes(), private) {
		t.Fatalf("post-open path swap changed served content: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestPublicFileContainmentPinnedDirectoryDoesNotReopenPath(t *testing.T) {
	_, _, static := publicFileContainmentFixture(t)
	for _, name := range []string{"assets", ".private"} {
		if err := os.Mkdir(filepath.Join(static, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	original := []byte("SYNTHETIC-PUBLIC-PINNED-DIRECTORY")
	publicFileContainmentWrite(t, filepath.Join(static, "assets", "fixture.txt"), original)
	publicFileContainmentWrite(t, filepath.Join(static, ".private", "fixture.txt"), []byte("SYNTHETIC-HIDDEN-DIRECTORY"))
	base, err := os.OpenRoot(static)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	file, _, err := restaurantOpenPublicFileInRoot(base, "assets/fixture.txt", func(component string) {
		if component != "assets/fixture.txt" {
			return
		}
		if err := os.Rename(filepath.Join(static, "assets"), filepath.Join(static, "moved-assets")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(".private", filepath.Join(static, "assets")); err != nil {
			t.Fatal(err)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || !bytes.Equal(data, original) {
		t.Fatalf("pinned directory was reopened by pathname: %v", err)
	}
}

func TestPublicFileContainmentHTTPCompatibility(t *testing.T) {
	h, _, static := publicFileContainmentFixture(t)
	imageURL := publicFileContainmentUpload(t, h)
	publicFileContainmentWrite(t, filepath.Join(static, "app.js"), []byte("/* SYNTHETIC-PUBLIC-JS-RANGE-CONTROL */"))
	if err := os.Mkdir(filepath.Join(static, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	publicFileContainmentWrite(t, filepath.Join(static, "nested", "app.css"), []byte("/* SYNTHETIC-PUBLIC-CSS */"))
	publicFileContainmentWrite(t, filepath.Join(static, "nested", "index.html"), []byte("SYNTHETIC-PUBLIC-NESTED-INDEX"))
	for _, path := range []string{imageURL, "/app.js", "/nested/app.css", "/order"} {
		t.Run(path, func(t *testing.T) {
			get := publicFileContainmentRequest(h, http.MethodGet, path)
			if get.Code != http.StatusOK || get.Body.Len() < 4 || get.Header().Get("Content-Type") == "" || get.Header().Get("Last-Modified") == "" {
				t.Fatalf("normal GET %s: status=%d headers=%v", path, get.Code, get.Header())
			}
			wantType := map[string]string{imageURL: "image/png", "/app.js": "text/javascript", "/nested/app.css": "text/css", "/order": "text/html"}[path]
			contentType, _, err := mime.ParseMediaType(get.Header().Get("Content-Type"))
			// System MIME databases may use either standard JavaScript spelling.
			if err != nil || (contentType != wantType && !(path == "/app.js" && contentType == "application/javascript")) {
				t.Fatalf("GET %s MIME=%q want=%q err=%v", path, contentType, wantType, err)
			}
			head := publicFileContainmentRequest(h, http.MethodHead, path)
			if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(get.Body.Len()) || head.Header().Get("Content-Type") != get.Header().Get("Content-Type") {
				t.Fatalf("HEAD %s: status=%d body=%d headers=%v", path, head.Code, head.Body.Len(), head.Header())
			}
			for _, conditional := range []bool{false, true} {
				r := httptest.NewRequest(http.MethodGet, "https://restaurant.example"+path, nil)
				if conditional {
					r.Header.Set("If-Modified-Since", get.Header().Get("Last-Modified"))
				} else {
					r.Header.Set("Range", "bytes=1-3")
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if conditional {
					if w.Code != http.StatusNotModified || w.Body.Len() != 0 {
						t.Fatalf("conditional GET: status=%d body=%d", w.Code, w.Body.Len())
					}
				} else if w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), get.Body.Bytes()[1:4]) || w.Header().Get("Content-Range") == "" {
					t.Fatalf("range GET: status=%d body=%s headers=%v", w.Code, w.Body.String(), w.Header())
				}
			}
			if get.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("security header lost")
			}
			if path == imageURL && get.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatal("public image caching changed")
			}
			if path == "/order" && get.Header().Get("Cache-Control") != "no-cache" {
				t.Fatal("SPA caching changed")
			}
		})
	}
	for _, path := range []string{"/index.html", "/nested/index.html"} {
		w := publicFileContainmentRequest(h, http.MethodGet, path+"?fixture=yes")
		if w.Code != http.StatusMovedPermanently || w.Header().Get("Location") != "./?fixture=yes" {
			t.Fatalf("canonical index redirect: status=%d location=%q", w.Code, w.Header().Get("Location"))
		}
	}
}

func TestPublicFileContainmentPathSyntax(t *testing.T) {
	_, _, static := publicFileContainmentFixture(t)
	for _, name := range []string{"", ".", "..", "../fixture.txt", ".private.txt", "assets/.private.txt", "/fixture.txt", "assets//fixture.txt", "assets/../fixture.txt", "assets/fixture.txt/", "assets\\fixture.txt"} {
		file, _, err := restaurantOpenPublicFile(static, name)
		if file != nil {
			file.Close()
			t.Fatalf("invalid public path opened: %q", name)
		}
		if err == nil {
			t.Fatalf("invalid public path accepted: %q", name)
		}
	}
}

func TestPublicFileContainmentTrustedConfiguredBase(t *testing.T) {
	_, owned, static := publicFileContainmentFixture(t)
	marker := []byte("SYNTHETIC-TRUSTED-CONFIGURED-BASE")
	publicFileContainmentWrite(t, filepath.Join(static, "fixture.txt"), marker)
	alias := filepath.Join(owned, "configured-root")
	if err := os.Symlink(static, alias); err != nil {
		t.Fatal(err)
	}
	file, _, err := restaurantOpenPublicFile(alias, "fixture.txt")
	if err != nil {
		t.Fatalf("trusted configured base symlink changed semantics: %v", err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || !bytes.Equal(data, marker) {
		t.Fatal("trusted configured base returned wrong file")
	}
}

func TestPublicFileContainmentMissingMediaThenFirstUpload(t *testing.T) {
	h, root, _ := publicFileContainmentFixture(t)
	dir := filepath.Join(root, "media", "restaurant-images")
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	w := publicFileContainmentRequest(h, http.MethodGet, "/restaurant-media/"+strings.Repeat("c", 64)+".png")
	if w.Code != http.StatusNotFound || strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("missing image should not acquire immutable caching: status=%d cache=%q", w.Code, w.Header().Get("Cache-Control"))
	}
	url := publicFileContainmentUpload(t, h)
	w = publicFileContainmentRequest(h, http.MethodGet, url)
	if w.Code != http.StatusOK {
		t.Fatalf("first upload after missing directory: %d", w.Code)
	}
}

func TestPublicFileContainmentHiddenMediaAndIndex(t *testing.T) {
	for _, kind := range []string{"media", "spa-index"} {
		t.Run(kind, func(t *testing.T) {
			h, root, static := publicFileContainmentFixture(t)
			marker := []byte("SYNTHETIC-HIDDEN-MEDIA-OR-INDEX")
			directory, name, request := static, "index.html", "/order"
			if kind == "media" {
				directory = filepath.Join(root, "media", "restaurant-images")
				name = strings.Repeat("d", 64) + ".png"
				request = "/restaurant-media/" + name
			} else if err := os.Remove(filepath.Join(directory, name)); err != nil {
				t.Fatal(err)
			}
			publicFileContainmentWrite(t, filepath.Join(directory, ".private.txt"), marker)
			if err := os.Symlink(".private.txt", filepath.Join(directory, name)); err != nil {
				t.Fatal(err)
			}
			w := publicFileContainmentRequest(h, http.MethodGet, request)
			if w.Code != http.StatusNotFound || bytes.Contains(w.Body.Bytes(), marker) {
				t.Fatalf("same-root hidden %s alias: status=%d body=%s", kind, w.Code, w.Body.String())
			}
		})
	}
}
