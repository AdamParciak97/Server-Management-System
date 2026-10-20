package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentRoutesRejectMissingCertificate(t *testing.T) {
	// A nil database also proves unauthenticated requests are stopped before
	// any supplied agent ID or command ID can be used in a database operation.
	s := New(nil, []byte("test-only-secret"), t.TempDir(), t.TempDir(), "")
	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"commands_query_identity", http.MethodGet, "/api/agent/commands?agent_id=00000000-0000-0000-0000-000000000001", ""},
		{"forged_report", http.MethodPost, "/api/agent/report", `{"agent_id":"00000000-0000-0000-0000-000000000001"}`},
		{"forged_result", http.MethodPost, "/api/agent/commands/result", `{"agent_id":"00000000-0000-0000-0000-000000000001","command_id":"00000000-0000-0000-0000-000000000002","status":"success"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-000000000001")
			r.Header.Set("X-SSL-Client-Verify", "SUCCESS")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401; body = %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestOnlyRegistrationCanReachHandlerWithoutCertificate(t *testing.T) {
	s := &Server{}
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{
		{http.MethodPost, "/api/agent/register", true},
		{http.MethodGet, "/api/agent/register", false},
		{http.MethodPost, "/api/agent/register/extra", false},
		{http.MethodPost, "/api/agent/report", false},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			called := false
			handler := s.mtlsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if called != tc.allowed {
				t.Fatalf("handler called = %v, want %v", called, tc.allowed)
			}
		})
	}
}

func TestRegistrationStillValidatesRequestWithoutCertificate(t *testing.T) {
	s := New(nil, []byte("test-only-secret"), t.TempDir(), t.TempDir(), "")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/agent/register", strings.NewReader("{")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want registration validation 400; body = %s", w.Code, w.Body.String())
	}
}
