package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sms/server-mgmt/server/db"
)

type packageStoreStub struct {
	record db.PackageRecord
	err error
	calls int
	contents []byte
}

func (s *packageStoreStub) CreatePackage(_ context.Context, record db.PackageRecord) (*db.PackageRecord, error) {
	s.calls++
	s.record = record
	var err error
	s.contents, err = os.ReadFile(record.FilePath)
	if err != nil { return nil, err }
	if s.err != nil { return nil, s.err }
	record.ID = "synthetic-id"
	return &record, nil
}

type packagePart struct { key, filename, value string }

func packageBody(t *testing.T, parts []packagePart) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for _, part := range parts {
		var writer io.Writer
		var err error
		if part.filename != "" { writer, err = w.CreateFormFile(part.key, part.filename) } else { writer, err = w.CreateFormField(part.key) }
		if err != nil { t.Fatal(err) }
		if _, err := io.WriteString(writer, part.value); err != nil { t.Fatal(err) }
	}
	if err := w.Close(); err != nil { t.Fatal(err) }
	return body.Bytes(), w.FormDataContentType()
}

func goodPackageParts() []packagePart {
	return []packagePart{{"name", "", "sms-agent"}, {"version", "", "1.0+test"}, {"os_target", "", "linux"}, {"arch_target", "", "amd64"}, {"file", "agent.bin", "synthetic binary\x00\xff"}}
}

func uploadTestRequest(body []byte, contentType string, claims *JWTClaims) *http.Request {
	r := httptest.NewRequest("POST", "/api/packages/upload", bytes.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	if claims != nil { r = r.WithContext(context.WithValue(r.Context(), ctxUser, claims)) }
	return r
}

func TestPackageUploadPermissions(t *testing.T) {
	for _, tc := range []struct { name string; claims *JWTClaims; status int }{
		{"anonymous", nil, 401},
		{"readonly", &JWTClaims{Role: "readonly", Permissions: []string{"packages.read"}}, 403},
		{"operator without grant", &JWTClaims{Role: "operator"}, 403},
		{"writer", &JWTClaims{Role: "operator", Permissions: []string{"packages.write"}}, 200},
		{"admin", &JWTClaims{Role: "admin"}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{uploadDir: t.TempDir()}
			store := &packageStoreStub{}
			body, ct := packageBody(t, goodPackageParts())
			w := httptest.NewRecorder()
			s.uploadPackage(w, uploadTestRequest(body, ct, tc.claims), store, 8192, 64)
			if w.Code != tc.status { t.Fatalf("status %d: %s", w.Code, w.Body.String()) }
			if tc.status != 200 {
				entries, _ := os.ReadDir(s.uploadDir)
				if store.calls != 0 || len(entries) != 0 { t.Fatal("unauthorized request touched storage") }
			}
		})
	}
}

func TestPackageUploadStreamHashAndPublication(t *testing.T) {
	for _, fileFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(fileFirst), func(t *testing.T) {
			parts := goodPackageParts()
			if fileFirst { parts = append(parts[4:], parts[:4]...) }
			body, ct := packageBody(t, parts)
			s := &Server{uploadDir: t.TempDir()}
			store := &packageStoreStub{}
			w := httptest.NewRecorder()
			r := uploadTestRequest(body, ct, &JWTClaims{Role: "admin", UserID: "synthetic-uploader"})
			r.ContentLength = -1 // Unknown length/chunked uploads use the same bound.
			s.uploadPackage(w, r, store, int64(len(body)), int64(len("synthetic binary\x00\xff")))
			if w.Code != 200 { t.Fatalf("status=%d: %s", w.Code, w.Body.String()) }
			want := "synthetic binary\x00\xff"
			if string(store.contents) != want || store.record.FileSize != int64(len(want)) || store.record.SHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(want))) { t.Fatal("incorrect content, size or hash") }
			if store.record.UploadedBy == nil || *store.record.UploadedBy != "synthetic-uploader" { t.Fatal("missing attribution") }
			if strings.Contains(w.Body.String(), "file_path") || strings.Contains(w.Body.String(), s.uploadDir) { t.Fatal("storage path leaked") }
			if !strings.Contains(w.Body.String(), `"filename":"`+filepath.Base(store.record.FilePath)+`"`) { t.Fatal("download filename missing") }
			entries, _ := os.ReadDir(s.uploadDir)
			if len(entries) != 1 || strings.HasSuffix(entries[0].Name(), ".partial") { t.Fatal("temporary or duplicate files left") }
		})
	}
}

func TestPackageUploadRejectsInvalidAndCleansStorage(t *testing.T) {
	for _, name := range []string{"empty", "large file", "duplicate file", "duplicate field", "unknown field", "large field", "missing name", "missing file", "traversal name", "traversal filename", "windows filename", "unsupported target", "truncated", "truncated file", "epilogue", "body limit", "known body limit", "database failure", "duplicate release", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			parts := goodPackageParts()
			want := 400
			switch name {
			case "empty": parts[4].value = ""
			case "large file": parts[4].value = strings.Repeat("x", 65); want = 413
			case "duplicate file": parts = append(parts, parts[4])
			case "duplicate field": parts = append(parts, parts[0])
			case "unknown field": parts = append(parts, packagePart{"extra", "", "x"})
			case "large field": parts = append(parts, packagePart{"description", "", strings.Repeat("x", 4097)}); want = 413
			case "missing name": parts = parts[1:]
			case "missing file": parts = parts[:4]
			case "traversal name": parts[0].value = "../../escape"
			case "traversal filename": parts[4].filename = "../../outside.bin"
			case "windows filename": parts[4].filename = `..\outside.bin`
			case "unsupported target": parts[2].value = "other"
			}
			body, ct := packageBody(t, parts)
			limit := int64(8192)
			if name == "truncated" { body = body[:len(body)-12] }
			if name == "truncated file" { body = body[:bytes.Index(body, []byte("synthetic binary"))+5] }
			if name == "epilogue" { body = append(body, bytes.Repeat([]byte("x"), 9000)...); want = 413 }
			if name == "body limit" || name == "known body limit" { limit = int64(len(body)-1); want = 413 }
			store := &packageStoreStub{}
			if name == "database failure" { store.err = errors.New("synthetic database failure"); want = 500 }
			if name == "duplicate release" { store.err = &pgconn.PgError{Code: "23505"}; want = 409 }
			s := &Server{uploadDir: t.TempDir()}
			// Pre-existing data must survive all cleanup paths.
			preserved := filepath.Join(s.uploadDir, "existing.bin")
			if err := os.WriteFile(preserved, []byte("keep"), 0600); err != nil { t.Fatal(err) }
			r := uploadTestRequest(body, ct, &JWTClaims{Role: "admin"})
			if name != "known body limit" { r.ContentLength = -1 }
			if name == "cancelled" { ctx, cancel := context.WithCancel(r.Context()); cancel(); r = r.WithContext(ctx) }
			w := httptest.NewRecorder()
			s.uploadPackage(w, r, store, limit, 64)
			if w.Code != want { t.Fatalf("status=%d want=%d: %s", w.Code, want, w.Body.String()) }
			entries, _ := os.ReadDir(s.uploadDir)
			if len(entries) != 1 || entries[0].Name() != "existing.bin" { t.Fatalf("failed upload left files: %v", entries) }
			if name != "database failure" && name != "duplicate release" && store.calls != 0 { t.Fatal("invalid request reached database") }
		})
	}
}

func TestPackageUploadStorageFailure(t *testing.T) {
	blocked := filepath.Join(t.TempDir(), "existing-file")
	if err := os.WriteFile(blocked, []byte("keep"), 0600); err != nil { t.Fatal(err) }
	s := &Server{uploadDir: blocked}
	store := &packageStoreStub{}
	body, ct := packageBody(t, goodPackageParts())
	w := httptest.NewRecorder()
	s.uploadPackage(w, uploadTestRequest(body, ct, &JWTClaims{Role: "admin"}), store, 8192, 64)
	if w.Code != 500 || store.calls != 0 { t.Fatalf("storage failure status=%d calls=%d", w.Code, store.calls) }
	content, err := os.ReadFile(blocked)
	if err != nil || string(content) != "keep" { t.Fatal("existing data changed") }
}

func TestPackageDownloadContainmentAndHeaders(t *testing.T) {
	s := &Server{uploadDir: t.TempDir()}
	valid := filepath.Join(s.uploadDir, "synthetic.bin")
	if err := os.WriteFile(valid, []byte("synthetic"), 0600); err != nil { t.Fatal(err) }
	outside := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil { t.Fatal(err) }
	for _, path := range []string{outside, filepath.Join(s.uploadDir, "..", "outside.bin"), s.uploadDir, filepath.Join(s.uploadDir, "missing.bin")} {
		w := httptest.NewRecorder()
		s.servePackage(w, httptest.NewRequest("GET", "/download", nil), &db.PackageRecord{FilePath: path}, "test.bin")
		if w.Code != 404 || strings.Contains(w.Body.String(), "outside") { t.Fatalf("unsafe path served: %d", w.Code) }
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/download", nil)
	r.Header.Set("Range", "bytes=0-2")
	s.servePackage(w, r, &db.PackageRecord{FilePath: valid}, "synthetic file.bin")
	if w.Code != 206 || w.Body.String() != "syn" { t.Fatalf("range download failed: %d %s", w.Code, w.Body.String()) }
	if w.Header().Get("Content-Type") != "application/octet-stream" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Security-Policy") != "sandbox" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") { t.Fatal("missing safe download headers") }
	t.Run("symlink", func(t *testing.T) {
		link := filepath.Join(s.uploadDir, "link.bin")
		if err := os.Symlink(outside, link); err != nil { t.Skipf("symlinks unavailable: %v", err) }
		if _, err := s.packagePath(link); err == nil { t.Fatal("symlink accepted for download/delete") }
		w := httptest.NewRecorder()
		s.servePackage(w, httptest.NewRequest("GET", "/download", nil), &db.PackageRecord{FilePath: link}, "test.bin")
		if w.Code != 404 { t.Fatal("symlink download accepted") }
	})
}
