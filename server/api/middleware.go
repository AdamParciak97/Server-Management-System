package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/sms/server-mgmt/server/db"
)

type contextKey string

const (
	ctxUser    contextKey = "user"
	ctxAgentID contextKey = "agent_id"
)

type JWTClaims struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Permissions []string `json:"permissions,omitempty"`
	GroupScopes []string `json:"group_scopes,omitempty"`
	jwt.RegisteredClaims
}

func (s *Server) jwtMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			respondError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tokenStr := auth[7:]
		claims := &JWTClaims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return s.jwtSecret, nil
		})
		if err != nil || !token.Valid {
			respondError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUser, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) requireRole(roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := r.Context().Value(ctxUser).(*JWTClaims)
			if !ok {
				respondError(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			for _, role := range roles {
				if claims.Role == role {
					next.ServeHTTP(w, r)
					return
				}
			}
			respondError(w, http.StatusForbidden, "insufficient permissions")
		})
	}
}

func (s *Server) requirePermission(permissions ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := r.Context().Value(ctxUser).(*JWTClaims)
			if !ok {
				respondError(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			if claims.Role == "admin" {
				next.ServeHTTP(w, r)
				return
			}
			for _, expected := range permissions {
				for _, granted := range claims.Permissions {
					if granted == expected {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			respondError(w, http.StatusForbidden, "insufficient permissions")
		})
	}
}

// requireRole as a direct middleware handler (for use with chi.With)
func (s *Server) requireRoleMiddleware(roles ...string) func(http.Handler) http.Handler {
	return s.requireRole(roles...)
}

func (s *Server) mtlsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var fingerprint string

		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			cert := r.TLS.PeerCertificates[0]
			h := sha256.Sum256(cert.Raw)
			fingerprint = fmt.Sprintf("%x", h)
		}

		if fingerprint == "" {
			// Allow registration without cert (uses token instead)
			next.ServeHTTP(w, r)
			return
		}

		agent, err := s.db.GetAgentByCert(r.Context(), fingerprint)
		if err != nil {
			// Unknown cert but allow to proceed (registration endpoint handles this)
			next.ServeHTTP(w, r)
			return
		}

		ctx := context.WithValue(r.Context(), ctxAgentID, agent.ID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) auditMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := &wrappedWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(ww, r)

		claims, _ := r.Context().Value(ctxUser).(*JWTClaims)
		username := "anonymous"
		var userID *string
		if claims != nil {
			username = claims.Username
			userID = &claims.UserID
		}

		result := "success"
		if ww.status >= 400 {
			result = "failure"
		}

		ip := r.RemoteAddr
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			ip = strings.Split(xff, ",")[0]
		}

		// Only audit write operations
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			_ = s.db.WriteAudit(r.Context(), userID, username, ip,
				r.Method+" "+r.URL.Path, "", "", result, nil)
		}
	})
}

func logMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := &wrappedWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(ww, r)
			logger.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.status,
				"duration_ms", time.Since(start).Milliseconds(),
				"remote", r.RemoteAddr,
			)
		})
	}
}

type wrappedWriter struct {
	http.ResponseWriter
	status int
}

func (w *wrappedWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func getUserFromCtx(ctx context.Context) *JWTClaims {
	v, _ := ctx.Value(ctxUser).(*JWTClaims)
	return v
}

func getAgentIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxAgentID).(string)
	return v
}

func (s *Server) getClaims(ctx context.Context) *JWTClaims {
	claims, _ := ctx.Value(ctxUser).(*JWTClaims)
	return claims
}

func (s *Server) isScoped(claims *JWTClaims) bool {
	return claims != nil && claims.Role != "admin" && len(claims.GroupScopes) > 0
}

func (s *Server) canAccessGroup(claims *JWTClaims, groupID *string) bool {
	if claims == nil || claims.Role == "admin" || len(claims.GroupScopes) == 0 {
		return true
	}
	if groupID == nil || *groupID == "" {
		return false
	}
	for _, allowed := range claims.GroupScopes {
		if allowed == *groupID {
			return true
		}
	}
	return false
}

func (s *Server) filterAgentsByScope(claims *JWTClaims, agents []*db.Agent) []*db.Agent {
	if !s.isScoped(claims) {
		return agents
	}
	out := make([]*db.Agent, 0, len(agents))
	for _, agent := range agents {
		if s.canAccessGroup(claims, agent.GroupID) {
			out = append(out, agent)
		}
	}
	return out
}

func (s *Server) filterGroupsByScope(claims *JWTClaims, groups []*db.Group) []*db.Group {
	if !s.isScoped(claims) {
		return groups
	}
	out := make([]*db.Group, 0, len(groups))
	for _, group := range groups {
		groupID := group.ID
		if s.canAccessGroup(claims, &groupID) {
			out = append(out, group)
		}
	}
	return out
}

// ─── JWT generation ───────────────────────────────────────────────────────────

func (s *Server) generateAccessToken(ctx context.Context, user *db.User) (string, error) {
	extraPermissions, _ := s.db.ListUserPermissions(ctx, user.ID)
	groupScopes, _ := s.db.ListUserGroupScopes(ctx, user.ID)
	effectivePermissions := db.BuildEffectivePermissions(user.Role, extraPermissions)
	claims := &JWTClaims{
		UserID:   user.ID,
		Username: user.Username,
		Role:     user.Role,
		Permissions: effectivePermissions,
		GroupScopes: groupScopes,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *Server) generateRefreshToken() string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(time.Now().UnixNano() & 0xff)
	}
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x%x", h, time.Now().UnixNano())
}

func refreshTokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", h)
}

// ─── Response helpers ─────────────────────────────────────────────────────────

func respond(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func respondOK(w http.ResponseWriter, data interface{}) {
	respond(w, http.StatusOK, map[string]interface{}{"success": true, "data": data})
}

func respondError(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]interface{}{"success": false, "error": msg})
}
