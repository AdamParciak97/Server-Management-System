package api

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	"github.com/sms/server-mgmt/server/db"
)

type Server struct {
	db        *db.DB
	router    *chi.Mux
	logger    *slog.Logger
	jwtSecret []byte
	uploadDir string
	agentsDir string
	caCertFile string
}

func New(database *db.DB, jwtSecret []byte, uploadDir, agentsDir, caCertFile string) *Server {
	s := &Server{
		db:        database,
		jwtSecret: jwtSecret,
		uploadDir: uploadDir,
		agentsDir: agentsDir,
		caCertFile: caCertFile,
		logger: slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		})),
	}
	s.router = s.buildRouter()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

func (s *Server) buildRouter() *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(logMiddleware(s.logger))
	r.Use(middleware.Timeout(60 * time.Second))

	// Global rate limit: 200 req/min per IP
	r.Use(httprate.LimitByIP(200, time.Minute))

	// Health check (no auth)
	r.Get("/health", s.handleHealth)
	r.Get("/api/ca.crt", s.handleCACertificate)
	r.Get("/api/packages/latest/{target}", s.handleLatestPackageDownload)
	r.Get("/api/packages/public/{id}", s.handlePackageDownload)
	r.Get("/api/packages/public/{id}/{filename}", s.handlePackageDownload)

	// ─── Agent API (mTLS authenticated) ─────────────────────────────────────
	r.Route("/api/agent", func(r chi.Router) {
		r.Use(s.mtlsMiddleware)
		// Stricter rate limit for agents
		r.Use(httprate.LimitByIP(60, time.Minute))

		r.Post("/register", s.handleAgentRegister)
		r.Post("/report", s.handleAgentReport)
		r.Get("/commands", s.handleGetCommands)
		r.Post("/commands/result", s.handleCommandResult)
	})

	// ─── Auth ────────────────────────────────────────────────────────────────
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/refresh", s.handleRefreshToken)
	r.With(s.jwtMiddleware).Post("/api/auth/logout", s.handleLogout)

	// ─── Authenticated API ───────────────────────────────────────────────────
	r.Route("/api", func(r chi.Router) {
		r.Use(s.jwtMiddleware)
		r.Use(s.auditMiddleware)

		// Servers
		r.With(s.requirePermission("servers.read")).Get("/servers", s.handleListServers)
		r.With(s.requirePermission("servers.read")).Get("/servers/{id}", s.handleGetServer)
		r.With(s.requirePermission("servers.read")).Get("/servers/{id}/history", s.handleServerHistory)
		r.With(s.requirePermission("servers.read")).Get("/servers/{id}/timeline", s.handleServerTimeline)
		r.With(s.requirePermission("servers.read")).Get("/servers/{id}/baseline", s.handleGetBaseline)
		r.With(s.requirePermission("servers.write")).Post("/servers/{id}/baseline", s.handleSetBaseline)
		r.With(s.requirePermission("servers.read")).Get("/servers/{id}/config/diff", s.handleConfigDiff)
		r.With(s.requirePermission("servers.write", "commands.write")).Post("/servers/{id}/report/force", s.handleForceReport)
		r.With(s.requirePermission("servers.write", "groups.write")).Put("/servers/{id}/group", s.handleAssignGroup)

		// Commands
		r.With(s.requirePermission("commands.write")).Post("/commands", s.handleCreateCommand)
		r.With(s.requirePermission("commands.read")).Get("/commands/templates", s.handleListCommandTemplates)
		r.With(s.requirePermission("commands.write")).Post("/commands/templates", s.handleCreateCommandTemplate)
		r.With(s.requirePermission("commands.write")).Delete("/commands/templates/{id}", s.handleDeleteCommandTemplate)
		r.With(s.requirePermission("commands.write")).Post("/commands/scheduled", s.handleCreateScheduled)
		r.With(s.requirePermission("commands.read")).Get("/commands/scheduled", s.handleListScheduledCommands)
		r.With(s.requirePermission("commands.read")).Get("/maintenance-windows", s.handleListMaintenanceWindows)
		r.With(s.requirePermission("commands.write")).Post("/maintenance-windows", s.handleCreateMaintenanceWindow)
		r.With(s.requirePermission("commands.write")).Delete("/maintenance-windows/{id}", s.handleDeleteMaintenanceWindow)
		r.With(s.requirePermission("commands.read")).Get("/commands", s.handleListCommands)
		r.With(s.requirePermission("commands.read")).Get("/commands/{id}/log", s.handleCommandLog)
		r.With(s.requirePermission("commands.write")).Delete("/commands/{id}", s.handleCancelCommand)
		r.With(s.requirePermission("commands.write")).Delete("/commands/scheduled/{id}", s.handleDeleteScheduledCommand)
		r.With(s.requirePermission("commands.approve")).Post("/commands/{id}/approve", s.handleApproveCommand)

		// Alerts
		r.With(s.requirePermission("alerts.read")).Get("/alerts", s.handleListAlerts)
		r.With(s.requirePermission("alerts.ack")).Post("/alerts/{id}/acknowledge", s.handleAcknowledgeAlert)

		// Packages
		r.With(s.requirePermission("packages.write")).Post("/packages/upload", s.handlePackageUpload)
		r.With(s.requirePermission("packages.read")).Get("/packages", s.handleListPackages)
		r.With(s.requirePermission("packages.read")).Get("/packages/{id}/download", s.handlePackageDownload)
		r.With(s.requirePermission("packages.write")).Delete("/packages/{id}", s.handleDeletePackage)

		// Compliance
		r.With(s.requirePermission("compliance.read")).Get("/compliance", s.handleCompliance)
		r.With(s.requirePermission("compliance.read")).Get("/compliance/policies", s.handleListCompliancePolicies)
		r.With(s.requirePermission("compliance.write")).Post("/compliance/policies", s.handleCreateCompliancePolicy)
		r.With(s.requirePermission("compliance.write")).Delete("/compliance/policies/{id}", s.handleDeleteCompliancePolicy)
		r.With(s.requirePermission("compliance.read")).Get("/compliance/exceptions", s.handleListComplianceExceptions)
		r.With(s.requirePermission("compliance.write")).Post("/compliance/exceptions", s.handleCreateComplianceException)
		r.With(s.requirePermission("compliance.write")).Delete("/compliance/exceptions/{id}", s.handleDeleteComplianceException)
		r.With(s.requirePermission("servers.read")).Get("/reports/export", s.handleExportReport)
		r.With(s.requirePermission("servers.read")).Post("/reports/{id}/email", s.handleEmailReport)

		// Users
		r.Route("/users", func(r chi.Router) {
			r.Use(s.requirePermission("users.read", "users.write"))
			r.Get("/", s.handleListUsers)
			r.With(s.requirePermission("users.write")).Post("/", s.handleCreateUser)
			r.With(s.requirePermission("users.write")).Delete("/{id}", s.handleDeleteUser)
			r.With(s.requirePermission("users.read")).Get("/{id}/permissions", s.handleListUserPermissions)
			r.With(s.requirePermission("users.write")).Put("/{id}/permissions", s.handleSetUserPermissions)
			r.With(s.requirePermission("users.read")).Get("/{id}/scopes", s.handleListUserScopes)
			r.With(s.requirePermission("users.write")).Put("/{id}/scopes", s.handleSetUserScopes)
		})
		r.Post("/account/password", s.handleChangePassword)

		// Groups
		r.With(s.requirePermission("groups.read")).Get("/groups", s.handleListGroups)
		r.With(s.requirePermission("groups.write")).Post("/groups", s.handleCreateGroup)
		r.With(s.requirePermission("groups.write")).Delete("/groups/{id}", s.handleDeleteGroup)
		r.With(s.requirePermission("groups.write")).Put("/groups/{id}/required-agents", s.handleSetRequiredAgents)

		// Registration tokens
		r.With(s.requirePermission("tokens.read")).Get("/tokens", s.handleListTokens)
		r.With(s.requirePermission("tokens.write")).Post("/tokens", s.handleCreateToken)

		// Audit log
		r.With(s.requirePermission("audit.read")).Get("/audit", s.handleListAudit)

		// Stats
		r.With(s.requirePermission("stats.read")).Get("/stats", s.handleStats)

		// Settings
		r.With(s.requirePermission("settings.read")).Get("/settings/ldap", s.handleGetLDAPSettings)
		r.With(s.requirePermission("settings.write")).Put("/settings/ldap", s.handleSetLDAPSettings)
		r.With(s.requirePermission("settings.read")).Get("/settings/ldap/mappings", s.handleListLDAPGroupMappings)
		r.With(s.requirePermission("settings.write")).Post("/settings/ldap/mappings", s.handleCreateLDAPGroupMapping)
		r.With(s.requirePermission("settings.write")).Delete("/settings/ldap/mappings/{id}", s.handleDeleteLDAPGroupMapping)
		r.With(s.requirePermission("settings.read")).Get("/settings/smtp", s.handleGetSMTPSettings)
		r.With(s.requirePermission("settings.write")).Put("/settings/smtp", s.handleSetSMTPSettings)
		r.With(s.requirePermission("users.read", "settings.read")).Get("/permissions/catalog", s.handlePermissionCatalog)
	})

	// Static files (dashboard)
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/index.html")
	})

	return r
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	err := s.db.Pool.Ping(ctx)
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	respondOK(w, map[string]string{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
}
