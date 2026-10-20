package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestHandlersRejectInvalidJSON(t *testing.T) {
	// A nil database ensures invalid input is rejected before database access.
	s := &Server{}
	handlers := []struct {
		name    string
		handler http.HandlerFunc
		message string
	}{
		{"register", s.handleAgentRegister, "invalid request body"},
		{"report", s.handleAgentReport, "invalid report body"},
		{"command_result", func(w http.ResponseWriter, r *http.Request) {
			// Model the identity supplied by mTLS so this tests JSON validation.
			r = r.WithContext(context.WithValue(r.Context(), ctxAgentID, "synthetic-agent"))
			s.handleCommandResult(w, r)
		}, "invalid request"},
		{"create_command", authenticatedValidationHandler(s.handleCreateCommand), "invalid command request (maximum 128 KiB)"},
		{"command_template", s.handleCreateCommandTemplate, "invalid request"},
	}
	bodies := []struct {
		name string
		body string
	}{
		{"empty", ""},
		{"truncated_object", `{"`},
		{"array_instead_of_object", `[]`},
	}
	for _, handler := range handlers {
		t.Run(handler.name, func(t *testing.T) {
			for _, body := range bodies {
				t.Run(body.name, func(t *testing.T) {
					assertValidationError(t, handler.handler, body.body, handler.message)
				})
			}
		})
	}
}

func TestHandlersRejectMissingRequiredFields(t *testing.T) {
	s := &Server{}
	tests := []struct {
		name    string
		handler http.HandlerFunc
		body    string
		message string
	}{
		{"report_missing_agent", s.handleAgentReport, `{}`, "missing agent_id"},
		{"report_empty_agent", s.handleAgentReport, `{"agent_id":""}`, "missing agent_id"},
		{"command_missing_target", authenticatedValidationHandler(s.handleCreateCommand), `{"type":"force_report"}`, "choose exactly one target: agent_id or group_id"},
		{"command_empty_targets", authenticatedValidationHandler(s.handleCreateCommand), `{"agent_id":"","group_id":"","type":"force_report"}`, "choose exactly one target: agent_id or group_id"},
		{"agent_command_missing_type", authenticatedValidationHandler(s.handleCreateCommand), `{"agent_id":"10000000-0000-0000-0000-000000000001"}`, "unsupported command type"},
		{"group_command_missing_type", authenticatedValidationHandler(s.handleCreateCommand), `{"group_id":"10000000-0000-0000-0000-000000000002"}`, "unsupported command type"},
		{"template_missing_name", s.handleCreateCommandTemplate, `{"type":"shell"}`, "name and type are required"},
		{"template_missing_type", s.handleCreateCommandTemplate, `{"name":"test-template"}`, "name and type are required"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationError(t, tt.handler, tt.body, tt.message)
		})
	}
}

func authenticatedValidationHandler(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Supply the identity established by authentication so validation is reached.
		claims := &JWTClaims{UserID: "10000000-0000-0000-0000-000000000010", Role: "admin"}
		handler(w, r.WithContext(context.WithValue(r.Context(), ctxUser, claims)))
	}
}

func assertValidationError(t *testing.T, handler http.HandlerFunc, body, message string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	var response map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	want := map[string]interface{}{"success": false, "error": message}
	if !reflect.DeepEqual(response, want) {
		t.Errorf("response = %#v, want %#v", response, want)
	}
}
