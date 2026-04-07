package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/sms/server-mgmt/server/alerting"
	"github.com/sms/server-mgmt/server/api"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/server/scheduler"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Config from environment
	dsn := getenv("DATABASE_URL", "postgres://sms:sms@localhost:5432/sms?sslmode=disable")
	addr := getenv("SERVER_ADDR", ":8443")
	jwtSecret := []byte(getenv("JWT_SECRET", "change-me-in-production-secret-key"))
	uploadDir := getenv("UPLOAD_DIR", "./uploads")
	agentsDir := getenv("AGENTS_DIR", "./agents")
	certFile := getenv("TLS_CERT_FILE", "./certs/server.crt")
	keyFile := getenv("TLS_KEY_FILE", "./certs/server.key")
	caCertFile := getenv("CA_CERT_FILE", "./certs/ca.crt")
	migrationsDir := getenv("MIGRATIONS_DIR", "file://server/migrations")

	// Run migrations
	logger.Info("running database migrations")
	if err := runMigrations(dsn, migrationsDir, logger); err != nil {
		logger.Error("migrations failed", "error", err)
		os.Exit(1)
	}

	// Connect to database
	ctx := context.Background()
	database, err := db.Connect(ctx, dsn)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer database.Close()
	logger.Info("database connected")

	// Start alerting monitor
	alertMonitor := alerting.New(database, logger)
	alertCtx, alertCancel := context.WithCancel(ctx)
	defer alertCancel()
	go alertMonitor.Start(alertCtx)

	// Start scheduler
	sched := scheduler.New(database, logger)
	schedCtx, schedCancel := context.WithCancel(ctx)
	defer schedCancel()
	if err := sched.Start(schedCtx); err != nil {
		logger.Error("scheduler start failed", "error", err)
		os.Exit(1)
	}

	// Build HTTP server
	server := api.New(database, jwtSecret, uploadDir, agentsDir, caCertFile)

	httpServer := &http.Server{
		Addr:         addr,
		Handler:      server,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// TLS setup
	useTLS := fileExists(certFile) && fileExists(keyFile)
	if useTLS {
		tlsCfg, err := api.BuildTLSConfig(certFile, keyFile)
		if err != nil {
			logger.Warn("tls config failed, starting without TLS", "error", err)
			useTLS = false
		} else {
			httpServer.TLSConfig = tlsCfg
		}
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		if useTLS {
			logger.Info("server starting with TLS", "addr", addr)
			if err := httpServer.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
				logger.Error("server error", "error", err)
				os.Exit(1)
			}
		} else {
			logger.Warn("TLS cert not found, starting without TLS", "addr", addr)
			if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				logger.Error("server error", "error", err)
				os.Exit(1)
			}
		}
	}()

	logger.Info("server ready", "addr", addr)
	<-quit
	logger.Info("shutting down...")

	shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 15*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "error", err)
	}
	logger.Info("server stopped")
}

func runMigrations(dsn, dir string, logger *slog.Logger) error {
	m, err := migrate.New(dir, dsn)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate up: %w", err)
	}

	v, _, _ := m.Version()
	logger.Info("migrations applied", "version", v)
	return nil
}

func getenv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
