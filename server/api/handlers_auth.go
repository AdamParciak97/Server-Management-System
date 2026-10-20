package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
)

func decodeAuthRequest(w http.ResponseWriter, r *http.Request, target interface{}) error {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil { return err }
	if err := decoder.Decode(new(interface{})); err != io.EOF { return errors.New("invalid request") }
	return nil
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeAuthRequest(w,r,&req); err != nil || req.Username=="" || req.Password=="" {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	user, hash, err := s.db.GetUserByUsername(r.Context(), req.Username)
	localOK := err == nil && user != nil && user.AuthSource != "ldap" && s.db.VerifyPassword(hash, req.Password)
	if !localOK {
		user, err = s.authenticateLDAP(r.Context(), req.Username, req.Password)
		hash = ""
		if err != nil || user == nil || !user.IsActive {
			respondError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
	}

	sessionID := uuid.New().String()
	accessToken, err := s.generateAccessToken(r.Context(), user, sessionID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	refreshToken, err := s.generateRefreshToken()
	if err != nil { respondError(w,500,"failed to generate token"); return }
	refreshHash := refreshTokenHash(refreshToken)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	ua := []rune(r.UserAgent())
	if len(ua)>512 { ua=ua[:512] }
	if err := s.db.CreateAccountSession(r.Context(), user.ID, hash, sessionID, refreshHash, string(ua), expiresAt); err != nil {
		sessionFailure(w,err)
		return
	}

	_ = s.db.UpdateUserLastLogin(r.Context(), user.ID)

	respondOK(w, map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"expires_in":    900,
		"user": map[string]string{
			"id":       user.ID,
			"username": user.Username,
			"role":     user.Role,
		},
	})
}

func (s *Server) handleRefreshToken(w http.ResponseWriter, r *http.Request) {
	s.refreshSession(w,r,s.db)
}

func (s *Server) refreshSession(w http.ResponseWriter, r *http.Request, store refreshSessionStore) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeAuthRequest(w,r,&req); err != nil || req.RefreshToken=="" || len(req.RefreshToken)>256 {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	hash := refreshTokenHash(req.RefreshToken)
	session, err := store.GetRefreshSession(r.Context(), hash)
	if err != nil {
		sessionFailure(w,err)
		return
	}

	user, err := store.GetUserByID(r.Context(), session.UserID)
	if err != nil {
		sessionFailure(w,err)
		return
	}
	if user==nil || !user.IsActive { sessionFailure(w,db.ErrSessionInvalid); return }

	// Prepare credentials before consuming the old token. Only commit publishes them.
	accessToken, err := s.accessForSession(r.Context(), user, session.ID, store)
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "failed to generate token")
		return
	}

	newRefreshToken, err := s.generateRefreshToken()
	if err != nil { respondError(w,500,"failed to generate token"); return }
	newRefreshHash := refreshTokenHash(newRefreshToken)
	if err = store.RotateAccountSession(r.Context(),user.ID,session.ID,hash,newRefreshHash); err != nil {
		sessionFailure(w,err)
		return
	}

	respondOK(w, map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": newRefreshToken,
		"expires_in":    900,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.revokeSessions(w,r,s.db,false)
}
