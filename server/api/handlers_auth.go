package api

import (
	"encoding/json"
	"net/http"
	"time"
)

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	user, hash, err := s.db.GetUserByUsername(r.Context(), req.Username)
	localOK := err == nil && user != nil && user.AuthSource != "ldap" && s.db.VerifyPassword(hash, req.Password)
	if !localOK {
		user, err = s.authenticateLDAP(r.Context(), req.Username, req.Password)
		if err != nil {
			respondError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
	}

	accessToken, err := s.generateAccessToken(r.Context(), user)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	refreshToken := s.generateRefreshToken()
	refreshHash := refreshTokenHash(refreshToken)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	if err := s.db.SaveRefreshToken(r.Context(), user.ID, refreshHash, expiresAt); err != nil {
		s.logger.Error("save refresh token", "error", err)
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
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	hash := refreshTokenHash(req.RefreshToken)
	userID, err := s.db.ValidateRefreshToken(r.Context(), hash)
	if err != nil {
		respondError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	user, err := s.db.GetUserByID(r.Context(), userID)
	if err != nil {
		respondError(w, http.StatusUnauthorized, "user not found")
		return
	}

	// Revoke old token
	_ = s.db.RevokeRefreshToken(r.Context(), hash)

	accessToken, err := s.generateAccessToken(r.Context(), user)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	newRefreshToken := s.generateRefreshToken()
	newRefreshHash := refreshTokenHash(newRefreshToken)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	_ = s.db.SaveRefreshToken(r.Context(), user.ID, newRefreshHash, expiresAt)

	respondOK(w, map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": newRefreshToken,
		"expires_in":    900,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.RefreshToken != "" {
		hash := refreshTokenHash(req.RefreshToken)
		_ = s.db.RevokeRefreshToken(r.Context(), hash)
	}
	respondOK(w, map[string]string{"status": "logged out"})
}
