package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/sms/server-mgmt/agent/buffer"
	"github.com/sms/server-mgmt/agent/collector"
	"github.com/sms/server-mgmt/agent/config"
	"github.com/sms/server-mgmt/agent/executor"
	"github.com/sms/server-mgmt/agent/watchdog"
	"github.com/sms/server-mgmt/shared"
)

const agentVersion = "1.0.0"

var (
	configPath  = flag.String("config", "/etc/sms-agent/config.yaml", "path to config file")
	genConfig   = flag.Bool("gen-config", false, "generate default config and exit")
	registerMode = flag.Bool("register", false, "force re-registration")
)

func main() {
	flag.Parse()

	if *genConfig {
		path := "/etc/sms-agent/config.yaml"
		if err := config.WriteDefault(path); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to write config: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Default config written to %s\n", path)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	logger := buildLogger(cfg)
	slog.SetDefault(logger)

	if handled, err := runWindowsServiceIfNeeded(cfg, *configPath, logger); err != nil {
		logger.Error("windows service startup failed", "error", err)
		os.Exit(1)
	} else if handled {
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := runAgent(ctx, cfg, *configPath, logger); err != nil {
		logger.Error("agent stopped with error", "error", err)
		os.Exit(1)
	}
}

func buildLogger(cfg *config.Config) *slog.Logger {
	level := slog.LevelInfo
	switch cfg.Agent.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	logHandlers := []slog.Handler{
		slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}),
	}
	if cfg.Agent.LogFile != "" {
		f, err := os.OpenFile(cfg.Agent.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err == nil {
			logHandlers = append(logHandlers, slog.NewJSONHandler(f, &slog.HandlerOptions{Level: level}))
		}
	}

	return slog.New(multiHandler(logHandlers...))
}

func runAgent(ctx context.Context, cfg *config.Config, configPath string, logger *slog.Logger) error {
	// Open local buffer
	if err := os.MkdirAll(dirOf(cfg.Agent.BufferDB), 0755); err != nil {
		logger.Error("create buffer dir", "error", err)
	}
	buf, err := buffer.New(cfg.Agent.BufferDB)
	if err != nil {
		logger.Error("open buffer", "error", err)
		return err
	}
	defer buf.Close()

	// Build HTTPS client with mTLS
	httpClient, err := buildHTTPClient(cfg)
	if err != nil {
		logger.Error("build http client", "error", err)
		return err
	}

	// Get or register agent ID
	agentID, err := getOrRegisterAgent(ctx, cfg, httpClient, buf, logger)
	if err != nil {
		logger.Error("registration failed", "error", err)
		return err
	}
	logger.Info("agent started", "id", agentID, "version", agentVersion)

	// Start command executor
	exec := executor.New(logger, cfg.Server.URL, configPath, cfg.Agent.ServiceName, time.Duration(cfg.Agent.CommandTimeout)*time.Second)
	go exec.Run(ctx)

	// Start result sender
	go sendResults(ctx, cfg, httpClient, agentID, exec.Results(), logger)

	// Start health server
	go startHealthServer(cfg.Agent.HealthPort, agentID, buf, logger)

	// Start watchdog
	wd := watchdog.New(logger, 10*time.Minute, func() {
		watchdog.SelfRestart(logger)
	})
	go wd.Start(ctx)

	// Start rate-limited flusher for buffered reports
	go flushBuffer(ctx, cfg, httpClient, agentID, buf, logger)

	// Main polling loop
	ticker := time.NewTicker(time.Duration(cfg.Agent.PollInterval) * time.Second)
	defer ticker.Stop()

	// Do first report immediately
	doReportAndPoll(ctx, cfg, httpClient, agentID, buf, exec, logger)
	wd.Beat()

	for {
		select {
		case <-ctx.Done():
			logger.Info("agent shutting down")
			return nil
		case <-ticker.C:
			doReportAndPoll(ctx, cfg, httpClient, agentID, buf, exec, logger)
			wd.Beat()
		}
	}
}

func doReportAndPoll(ctx context.Context, cfg *config.Config, client *http.Client,
	agentID string, buf *buffer.Buffer, exec *executor.Executor, logger *slog.Logger) {

	// Collect data
	report, err := collectReport(agentID, cfg.Agent.Version)
	if err != nil {
		logger.Error("collect report", "error", err)
		return
	}

	// Try to send report
	if err := sendReport(ctx, cfg, client, report); err != nil {
		logger.Warn("send report failed, buffering", "error", err)
		if bufErr := buf.Save(ctx, report); bufErr != nil {
			logger.Error("buffer report", "error", bufErr)
		}
	}

	// Poll for commands
	cmds, err := pollCommands(ctx, cfg, client, agentID)
	if err != nil {
		logger.Warn("poll commands failed", "error", err)
		return
	}
	if len(cmds) > 0 {
		logger.Info("received commands", "count", len(cmds))
		exec.Enqueue(cmds)
	}
}

func collectReport(agentID, version string) (*shared.AgentReport, error) {
	sysInfo, err := collector.CollectSystem()
	if err != nil {
		return nil, fmt.Errorf("collect system: %w", err)
	}

	pkgs, _ := collector.CollectPackages()
	services, _ := collector.CollectServices()
	serviceConfigs, _ := collector.CollectServiceConfigs()
	secAgents, _ := collector.CollectSecurityAgents()
	processes, _ := collector.CollectProcesses()
	eventLogs, _ := collector.CollectCriticalEventLogs()
	scheduledTasks, _ := collector.CollectScheduledTasks()

	return &shared.AgentReport{
		AgentID:        agentID,
		Timestamp:      time.Now().UTC(),
		AgentVersion:   version,
		System:         *sysInfo,
		Packages:       pkgs,
		Services:       services,
		ServiceConfigs: serviceConfigs,
		SecurityAgents: secAgents,
		Processes:      processes,
		EventLogs:      eventLogs,
		ScheduledTasks: scheduledTasks,
	}, nil
}

func sendReport(ctx context.Context, cfg *config.Config, client *http.Client, report *shared.AgentReport) error {
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST",
		cfg.Server.URL+"/api/agent/report", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server error %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func pollCommands(ctx context.Context, cfg *config.Config, client *http.Client, agentID string) ([]shared.Command, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		cfg.Server.URL+"/api/agent/commands?agent_id="+agentID, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("server returned %d", resp.StatusCode)
	}

	var apiResp struct {
		Data shared.CommandsResponse `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data.Commands, nil
}

func sendResults(ctx context.Context, cfg *config.Config, client *http.Client,
	agentID string, results <-chan *shared.CommandResult, logger *slog.Logger) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-results:
			result.AgentID = agentID
			data, err := json.Marshal(result)
			if err != nil {
				logger.Error("marshal result", "error", err)
				continue
			}
			req, err := http.NewRequestWithContext(ctx, "POST",
				cfg.Server.URL+"/api/agent/commands/result", bytes.NewReader(data))
			if err != nil {
				continue
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				logger.Error("send result", "error", err)
				continue
			}
			resp.Body.Close()
		}
	}
}

func flushBuffer(ctx context.Context, cfg *config.Config, client *http.Client,
	agentID string, buf *buffer.Buffer, logger *slog.Logger) {

	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count, _ := buf.Count(ctx)
			if count == 0 {
				continue
			}
			logger.Info("flushing buffered reports", "count", count)

			reports, ids, err := buf.Pending(ctx, 10)
			if err != nil {
				logger.Error("get pending", "error", err)
				continue
			}

			for i, report := range reports {
				if err := sendReport(ctx, cfg, client, report); err != nil {
					logger.Warn("flush failed", "error", err)
					_ = buf.IncrAttempts(ctx, ids[i])
					break
				}
				_ = buf.Delete(ctx, ids[i])
			}

			// Prune reports older than 7 days
			deleted, _ := buf.PruneOld(ctx, 7*24*time.Hour)
			if deleted > 0 {
				logger.Info("pruned old buffered reports", "count", deleted)
			}
		}
	}
}

func getOrRegisterAgent(ctx context.Context, cfg *config.Config,
	client *http.Client, buf *buffer.Buffer, logger *slog.Logger) (string, error) {

	// Check if we have a saved agent ID
	if !*registerMode {
		if id, err := buf.GetState(ctx, "agent_id"); err == nil && id != "" {
			logger.Info("using existing agent ID", "id", id)
			return id, nil
		}
	}

	if cfg.Agent.RegistrationToken == "" {
		return "", fmt.Errorf("registration token required for first-time registration")
	}

	hostname, _ := os.Hostname()
	regReq := shared.RegisterRequest{
		RegistrationToken: cfg.Agent.RegistrationToken,
		Hostname:          hostname,
		AgentVersion:      agentVersion,
	}

	data, _ := json.Marshal(regReq)
	req, err := http.NewRequestWithContext(ctx, "POST",
		cfg.Server.URL+"/api/agent/register", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("registration request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("registration failed %d: %s", resp.StatusCode, string(body))
	}

	var apiResp struct {
		Data shared.RegisterResponse `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return "", fmt.Errorf("parse registration response: %w", err)
	}

	agentID := apiResp.Data.AgentID
	if err := buf.SetState(ctx, "agent_id", agentID); err != nil {
		logger.Warn("save agent ID to buffer", "error", err)
	}

	logger.Info("registered successfully", "id", agentID)
	return agentID, nil
}

func buildHTTPClient(cfg *config.Config) (*http.Client, error) {
	tlsCfg := &tls.Config{
		InsecureSkipVerify: false,
		MinVersion:         tls.VersionTLS12,
	}

	// Load CA cert if provided
	if cfg.Server.CACert != "" {
		caCert, err := os.ReadFile(cfg.Server.CACert)
		if err != nil {
			return nil, fmt.Errorf("load CA cert: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("failed to parse CA cert")
		}
		tlsCfg.RootCAs = pool
	} else {
		// In dev/test mode, allow self-signed certs
		tlsCfg.InsecureSkipVerify = true
	}

	// Load client cert for mTLS
	if cfg.Server.ClientCert != "" && cfg.Server.ClientKey != "" {
		cert, err := tls.LoadX509KeyPair(cfg.Server.ClientCert, cfg.Server.ClientKey)
		if err != nil {
			return nil, fmt.Errorf("load client cert: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}

	transport := &http.Transport{
		TLSClientConfig: tlsCfg,
		MaxIdleConns:    5,
		IdleConnTimeout: 90 * time.Second,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}, nil
}

func startHealthServer(port int, agentID string, buf *buffer.Buffer, logger *slog.Logger) {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		count, _ := buf.Count(r.Context())
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":          "ok",
			"agent_id":        agentID,
			"buffered_reports": count,
			"time":            time.Now().UTC(),
		})
	})

	mux.HandleFunc("/report/force", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		// Signal to trigger immediate report
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	logger.Info("health server starting", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		logger.Error("health server", "error", err)
	}
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[:i]
		}
	}
	return "."
}

// multiHandler fans out to multiple slog handlers.
type multiLogHandler struct {
	handlers []slog.Handler
}

func multiHandler(handlers ...slog.Handler) slog.Handler {
	return &multiLogHandler{handlers: handlers}
}

func (m *multiLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (m *multiLogHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range m.handlers {
		if h.Enabled(ctx, r.Level) {
			_ = h.Handle(ctx, r)
		}
	}
	return nil
}

func (m *multiLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithAttrs(attrs)
	}
	return &multiLogHandler{handlers: handlers}
}

func (m *multiLogHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithGroup(name)
	}
	return &multiLogHandler{handlers: handlers}
}
