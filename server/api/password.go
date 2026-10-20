package api

import (
	"context"
	"net/http"

	"github.com/sms/server-mgmt/server/db"
)

type passwordStore interface {
	GetUserByID(context.Context, string) (*db.User, error)
	GetUserPasswordHash(context.Context, string) (string, error)
	VerifyPassword(string, string) bool
	UpdateUserPassword(context.Context, string, string, string) error
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, store passwordStore) {
	w.Header().Set("Cache-Control", "no-store")
	claims := getUserFromCtx(r.Context())
	if claims == nil || claims.UserID == "" || claims.SessionID == "" {
		respondError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decodeAuthRequest(w, r, &req); err != nil || req.CurrentPassword == "" {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if len(req.NewPassword) < 8 || len(req.NewPassword) > 72 {
		respondError(w, http.StatusBadRequest, "new password must be between 8 and 72 bytes")
		return
	}
	user, err := store.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		sessionFailure(w, err)
		return
	}
	if user == nil || !user.IsActive {
		sessionFailure(w, db.ErrSessionInvalid)
		return
	}
	if user.AuthSource == "ldap" {
		respondError(w, http.StatusBadRequest, "password is managed by ldap for this account")
		return
	}
	hash, err := store.GetUserPasswordHash(r.Context(), claims.UserID)
	if err != nil {
		sessionFailure(w, err)
		return
	}
	if !store.VerifyPassword(hash, req.CurrentPassword) {
		respondError(w, http.StatusBadRequest, "current password is incorrect")
		return
	}
	// The transaction compares this hash again under the account lock, changes
	// the password, revokes all sessions and writes the audit entry together.
	if err := store.UpdateUserPassword(r.Context(), claims.UserID, hash, req.NewPassword); err != nil {
		sessionFailure(w, err)
		return
	}
	respondOK(w, map[string]string{"status": "password_changed"})
}
