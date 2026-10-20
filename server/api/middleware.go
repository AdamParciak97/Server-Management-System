package api

import (
	"context"
	"crypto/sha256"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	SessionID string `json:"session_id"`
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Permissions []string `json:"permissions,omitempty"`
	GroupScopes []string `json:"group_scopes,omitempty"`
	jwt.RegisteredClaims
}

func (s *Server) jwtMiddleware(next http.Handler) http.Handler {
	return s.sessionMiddleware(next, s.db)
}

func (s *Server) sessionMiddleware(next http.Handler, store sessionValidator) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			respondError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tokenStr := auth[7:]
		claims := &JWTClaims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			if t.Method != jwt.SigningMethodHS256 {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return s.jwtSecret, nil
		}, jwt.WithExpirationRequired())
		if err != nil || !token.Valid {
			respondError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		if claims.SessionID == "" || claims.UserID == "" {
			respondError(w, http.StatusUnauthorized, "sign in again")
			return
		}
		if err := store.ValidateAccountSession(r.Context(), claims.UserID, claims.SessionID); err != nil {
			status := http.StatusServiceUnavailable
			if errors.Is(err, db.ErrSessionInvalid) { status = http.StatusUnauthorized }
			respondError(w, status, "session unavailable")
			return
		}
		// Authorization must not retain a removed permission or group scope until
		// JWT expiry. Database failures must never mean unrestricted access.
		user, err := store.GetUserByID(r.Context(), claims.UserID)
		if err != nil { respondError(w,503,"authorization unavailable"); return }
		if user == nil || !user.IsActive { respondError(w,401,"account unavailable"); return }
		permissions, err := store.ListUserPermissions(r.Context(), claims.UserID)
		if err != nil { respondError(w,503,"authorization unavailable"); return }
		scopes, err := store.ListUserGroupScopes(r.Context(), claims.UserID)
		if err != nil { respondError(w,503,"authorization unavailable"); return }
		claims.Role = user.Role
		claims.Username = user.Username
		claims.Permissions = db.BuildEffectivePermissions(user.Role, permissions)
		claims.GroupScopes = scopes
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
	return s.agentCertificateMiddleware(next, s.db)
}

type agentCertificateStore interface {
	GetAgentByCert(context.Context, string) (*db.Agent, error)
}

func (s *Server) agentCertificateMiddleware(next http.Handler, store agentCertificateStore) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Registration has its own one-time token check. Every other agent
		// endpoint requires an identity established from a registered certificate.
		if r.Method == http.MethodPost && r.URL.Path == "/api/agent/register" {
			next.ServeHTTP(w, r)
			return
		}
		fingerprint := clientCertificateFingerprint(r, time.Now())

		if fingerprint == "" {
			respondError(w, http.StatusUnauthorized, "registered client certificate required")
			return
		}

		agent, err := store.GetAgentByCert(r.Context(), fingerprint)
		if err != nil || agent == nil {
			respondError(w, http.StatusUnauthorized, "unknown client certificate")
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
	if claims == nil {
		return false
	}
	if claims.Role == "admin" || len(claims.GroupScopes) == 0 {
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

func (s *Server) generateAccessToken(ctx context.Context, user *db.User, sessionID string) (string, error) {
	return s.accessForSession(ctx, user, sessionID, s.db)
}

func (s *Server) accessForSession(ctx context.Context, user *db.User, sessionID string, store authorizationStore) (string, error) {
	extraPermissions, err := store.ListUserPermissions(ctx, user.ID)
	if err != nil { return "", err }
	groupScopes, err := store.ListUserGroupScopes(ctx, user.ID)
	if err != nil { return "", err }
	effectivePermissions := db.BuildEffectivePermissions(user.Role, extraPermissions)
	claims := &JWTClaims{
		SessionID: sessionID,
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

func (s *Server) generateRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil { return "", err }
	return hex.EncodeToString(b), nil
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
