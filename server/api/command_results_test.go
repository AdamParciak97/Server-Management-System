package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

type resultStoreStub struct {
	err       error
	agentID   string
	result    *shared.CommandResult
	writes    int
	alerts    int
}

func (s *resultStoreStub) UpdateCommandResult(_ context.Context, agentID string, result *shared.CommandResult) error {
	s.agentID, s.result = agentID, result
	s.writes++
	return s.err
}

func (s *resultStoreStub) CreateAlert(ctx context.Context, agentID *string, _, _, _, _ string) error {
	if ctx.Err() != nil || *agentID != s.agentID {
		return errors.New("invalid alert context or identity")
	}
	s.alerts++
	return nil
}

func TestCommandResultAuthenticatedIdentityAndResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		alerts int
	}{
		{"accepted", nil, http.StatusOK, 1},
		{"foreign_missing_or_terminal", db.ErrCommandResultConflict, http.StatusConflict, 0},
		{"invalid_result", db.ErrInvalidCommandResult, http.StatusBadRequest, 0},
		{"write_failed", errors.New("synthetic storage failure"), http.StatusInternalServerError, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			store := &resultStoreStub{err: tc.err}
			r := httptest.NewRequest(http.MethodPost, "/api/agent/commands/result",
				strings.NewReader(`{"agent_id":"forged-B","command_id":"synthetic-command","status":"error"}`))
			r = r.WithContext(context.WithValue(r.Context(), ctxAgentID, "authenticated-A"))
			w := httptest.NewRecorder()
			s.acceptCommandResult(w, r, store)
			if w.Code != tc.status || store.writes != 1 || store.alerts != tc.alerts {
				t.Fatalf("status=%d writes=%d alerts=%d body=%s", w.Code, store.writes, store.alerts, w.Body.String())
			}
			if store.agentID != "authenticated-A" || store.result.AgentID != "authenticated-A" {
				t.Fatal("body identity reached persistence")
			}
			if strings.Contains(w.Body.String(), "synthetic storage failure") {
				t.Fatal("internal storage error exposed")
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCommandHandlersRequireContextIdentity(t *testing.T) {
	s := &Server{}
	store := &resultStoreStub{}
	r := httptest.NewRequest(http.MethodPost, "/api/agent/commands/result?agent_id=forged",
		strings.NewReader(`{"agent_id":"forged","status":"success"}`))
	w := httptest.NewRecorder()
	s.acceptCommandResult(w, r, store)
	if w.Code != http.StatusUnauthorized || store.writes != 0 || store.alerts != 0 {
		t.Fatal("unauthenticated result reached persistence")
	}
	w = httptest.NewRecorder()
	s.handleGetCommands(w, httptest.NewRequest(http.MethodGet, "/api/agent/commands?agent_id=forged", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("query identity accepted: %d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, "/api/agent/commands/result", strings.NewReader("{"))
	r = r.WithContext(context.WithValue(r.Context(), ctxAgentID, "authenticated-A"))
	w = httptest.NewRecorder()
	s.acceptCommandResult(w, r, store)
	if w.Code != http.StatusBadRequest || store.writes != 0 {
		t.Fatal("malformed JSON reached persistence")
	}
}
