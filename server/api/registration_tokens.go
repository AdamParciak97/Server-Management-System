package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
)

type registrationTokenStore interface {
	ListRegistrationTokens(context.Context) ([]*db.RegToken, error)
	CreateRegistrationToken(context.Context, db.TokenActor, *time.Time, string) (*db.RegToken, error)
	RevokeRegistrationToken(context.Context, string, db.TokenActor) error
}

func tokenActor(r *http.Request) db.TokenActor {
	user := getUserFromCtx(r.Context())
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil { ip = r.RemoteAddr }
	return db.TokenActor{UserID: user.UserID, Username: user.Username, IP: ip}
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) { s.listTokens(w, r, s.db) }
func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) { s.createToken(w, r, s.db) }
func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) { s.revokeToken(w, r, s.db) }

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request, store registrationTokenStore) {
	w.Header().Set("Cache-Control", "no-store")
	s.requirePermission("tokens.read")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens, err := store.ListRegistrationTokens(r.Context())
		if err != nil { respondError(w, 500, "failed to list tokens"); return }
		public := make([]db.RegToken, 0, len(tokens))
		for _, token := range tokens {
			if token == nil { continue }
			copy := *token
			copy.Token = ""
			public = append(public, copy)
		}
		respondOK(w, public)
	})).ServeHTTP(w, r)
}

func (s *Server) createToken(w http.ResponseWriter, r *http.Request, store registrationTokenStore) {
	w.Header().Set("Cache-Control", "no-store")
	s.requirePermission("tokens.write")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		var req *struct {
			ExpiresAt *time.Time `json:"expires_at"`
			Note string `json:"note"`
		}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil || req == nil {
			respondError(w, 400, "invalid token request"); return
		}
		if decoder.Decode(new(any)) != io.EOF { respondError(w, 400, "invalid token request"); return }
		now := time.Now().UTC()
		if req.ExpiresAt == nil { expires := now.Add(24 * time.Hour); req.ExpiresAt = &expires }
		if !req.ExpiresAt.After(now) || req.ExpiresAt.After(now.Add(30 * 24 * time.Hour)) {
			respondError(w, 400, "expiry must be in the future and within 30 days"); return
		}
		req.Note = strings.TrimSpace(req.Note)
		if !utf8.ValidString(req.Note) || utf8.RuneCountInString(req.Note) > 200 {
			respondError(w, 400, "note must be at most 200 characters"); return
		}
		token, err := store.CreateRegistrationToken(r.Context(), tokenActor(r), req.ExpiresAt, req.Note)
		if err != nil { respondError(w, 500, "failed to create token"); return }
		respondOK(w, token)
	})).ServeHTTP(w, r)
}

func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request, store registrationTokenStore) {
	w.Header().Set("Cache-Control", "no-store")
	s.requirePermission("tokens.write")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := uuid.Parse(id); err != nil { respondError(w, 400, "invalid token ID"); return }
		err := store.RevokeRegistrationToken(r.Context(), id, tokenActor(r))
		if errors.Is(err, db.ErrRegistrationTokenUnavailable) {
			respondError(w, 409, "token is already used, revoked or unavailable"); return
		}
		if err != nil { respondError(w, 500, "failed to revoke token"); return }
		respondOK(w, map[string]string{"status": "revoked"})
	})).ServeHTTP(w, r)
}
