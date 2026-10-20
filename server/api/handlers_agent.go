package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

func (s *Server) handleAgentRegister(w http.ResponseWriter, r *http.Request) {
	s.registerAgent(w, r, s.db)
}

type agentRegistrationStore interface {
	RegisterAgentWithToken(context.Context, string, string, string, string) (string, error)
}

func (s *Server) registerAgent(w http.ResponseWriter, r *http.Request, store agentRegistrationStore) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var req shared.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if strings.TrimSpace(req.Hostname) == "" || len(req.Hostname) > 255 || len(req.AgentVersion) > 64 || len(req.RegistrationToken) > 128 || req.RegistrationToken == "" {
		respondError(w, http.StatusBadRequest, "invalid registration fields")
		return
	}

	certFP := clientCertificateFingerprint(r, time.Now())

	if certFP == "" {
		respondError(w, http.StatusUnauthorized, "client certificate required for registration")
		return
	}
	agentID, err := store.RegisterAgentWithToken(r.Context(), req.RegistrationToken, req.Hostname, certFP, req.AgentVersion)
	if errors.Is(err, db.ErrRegistrationTokenUnavailable) {
		respondError(w, http.StatusUnauthorized, "invalid or expired registration token")
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "registration failed")
		return
	}

	respondOK(w, shared.RegisterResponse{
		AgentID:    agentID,
		ServerTime: time.Now().Unix(),
	})
}

func (s *Server) handleAgentReport(w http.ResponseWriter, r *http.Request) {
	agentID := getAgentIDFromCtx(r.Context())

	var report shared.AgentReport
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		respondError(w, http.StatusBadRequest, "invalid report body")
		return
	}

	if agentID != "" {
		report.AgentID = agentID
	}
	if report.AgentID == "" {
		respondError(w, http.StatusBadRequest, "missing agent_id")
		return
	}

	// Update agent last seen
	info := map[string]interface{}{
		"hostname":     report.System.Hostname,
		"fqdn":         report.System.FQDN,
		"ips":          report.System.IPs,
		"os":           report.System.OS,
		"os_version":   report.System.OSVersion,
		"architecture": report.System.Architecture,
		"agent_version": report.AgentVersion,
	}
	if err := s.db.UpdateAgentLastSeen(r.Context(), report.AgentID, info); err != nil {
		s.logger.Error("update agent last seen", "error", err)
	}

	// Save report
	if _, err := s.db.SaveReport(r.Context(), &report); err != nil {
		s.logger.Error("save report", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to save report")
		return
	}

	// Check for alerts
	go s.checkAlerts(&report)

	respondOK(w, map[string]string{"status": "accepted"})
}

func (s *Server) handleGetCommands(w http.ResponseWriter, r *http.Request) {
	agentID := getAgentIDFromCtx(r.Context())

	if agentID == "" {
		respondError(w, http.StatusUnauthorized, "agent not identified")
		return
	}

	cmds, err := s.db.GetPendingCommands(r.Context(), agentID)
	if err != nil {
		s.logger.Error("get commands", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to get commands")
		return
	}

	// Convert to shared.Command
	var sharedCmds []shared.Command
	for _, c := range cmds {
		payloadBytes, _ := json.Marshal(c.Payload)
		var payload shared.CommandPayload
		_ = json.Unmarshal(payloadBytes, &payload)

		sc := shared.Command{
			ID:       c.ID,
			Type:     shared.CommandType(c.Type),
			Priority: shared.CommandPriority(c.Priority),
			DryRun:   c.DryRun,
			Payload:  payload,
			CreatedAt: c.CreatedAt,
			Timeout:  c.TimeoutSeconds,
		}
		sharedCmds = append(sharedCmds, sc)
	}

	if sharedCmds == nil {
		sharedCmds = []shared.Command{}
	}
	respondOK(w, shared.CommandsResponse{Commands: sharedCmds})
}

func (s *Server) handleCommandResult(w http.ResponseWriter, r *http.Request) {
	s.acceptCommandResult(w, r, s.db)
}

type commandResultStore interface {
	UpdateCommandResult(context.Context, string, *shared.CommandResult) error
	CreateAlert(context.Context, *string, string, string, string, string) error
}

func (s *Server) acceptCommandResult(w http.ResponseWriter, r *http.Request, store commandResultStore) {
	agentID := getAgentIDFromCtx(r.Context())
	if agentID == "" {
		respondError(w, http.StatusUnauthorized, "agent not identified")
		return
	}

	var result shared.CommandResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	result.AgentID = agentID

	if err := store.UpdateCommandResult(r.Context(), agentID, &result); err != nil {
		if errors.Is(err, db.ErrInvalidCommandResult) {
			respondError(w, http.StatusBadRequest, "invalid command result")
			return
		}
		if errors.Is(err, db.ErrCommandResultConflict) {
			// Do not reveal whether a command belongs to a different agent.
			respondError(w, http.StatusConflict, "command result not accepted")
			return
		}
		s.logger.Error("update command result", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to update result")
		return
	}

	// Create alert if command failed
	if result.Status == "error" || result.Status == "timeout" {
		if err := store.CreateAlert(r.Context(), &result.AgentID, "command_failed", "high",
			fmt.Sprintf("Command %s failed: %s", result.CommandID, result.Status), result.Error); err != nil {
			s.logger.Error("create command failure alert", "command_id", result.CommandID, "error", err)
		}
	}

	respondOK(w, map[string]string{"status": "ok"})
}

func (s *Server) checkAlerts(report *shared.AgentReport) {
	ctx := context.Background()

	// Check for stopped critical services
	for _, svc := range report.Services {
		if svc.Status == "stopped" && isCriticalService(svc.Name) {
			exists, _ := s.db.AlertExists(ctx, &report.AgentID, "critical_service_stopped")
			if !exists {
				_ = s.db.CreateAlert(ctx, &report.AgentID, "critical_service_stopped", "critical",
					fmt.Sprintf("Critical service stopped: %s", svc.Name),
					fmt.Sprintf("Service %s is not running on %s", svc.Name, report.System.Hostname))
			}
		}
	}

	// Check for missing security agents
	installedAgents := make(map[string]bool)
	for _, sa := range report.SecurityAgents {
		if sa.Status == "running" {
			installedAgents[sa.Name] = true
		}
	}

	// Get required agents for this agent's group
	agent, err := s.db.GetAgent(ctx, report.AgentID)
	if err == nil && agent.GroupID != nil {
		required, err := s.db.GetRequiredAgents(ctx, *agent.GroupID)
		if err == nil {
			for _, req := range required {
				if !installedAgents[req] {
					exists, _ := s.db.AlertExists(ctx, &report.AgentID, "missing_security_agent")
					if !exists {
						_ = s.db.CreateAlert(ctx, &report.AgentID, "missing_security_agent", "high",
							fmt.Sprintf("Missing required security agent: %s", req),
							fmt.Sprintf("Agent %s is not installed or not running on %s", req, report.System.Hostname))
					}
				}
			}
		}
	}

	policies, err := s.db.ListCompliancePolicies(ctx)
	if err != nil {
		return
	}
	for _, policy := range policies {
		if policy == nil || !policy.Enabled {
			continue
		}
		if policy.GroupID != nil && (agent == nil || agent.GroupID == nil || *policy.GroupID != *agent.GroupID) {
			continue
		}
		result := evaluatePolicy(policy, report.System, report.Services, report.Packages, report.SecurityAgents)
		if result.Compliant {
			continue
		}
		alertType := "missing_security_agent"
		switch policy.PolicyType {
		case "service_status":
			alertType = "critical_service_stopped"
		case "package_installed":
			alertType = "config_changed"
		case "security_agent":
			alertType = "missing_security_agent"
		}
		exists, _ := s.db.AlertExists(ctx, &report.AgentID, alertType)
		if !exists {
			_ = s.db.CreateAlert(ctx, &report.AgentID, alertType, policy.Severity,
				fmt.Sprintf("Policy failed: %s", policy.Name), result.Message)
		}
	}

	if len(report.EventLogs) > 0 {
		exists, _ := s.db.AlertExists(ctx, &report.AgentID, "critical_event")
		if !exists {
			lines := make([]string, 0, minAlertPreview(len(report.EventLogs), 3))
			for _, item := range report.EventLogs[:minAlertPreview(len(report.EventLogs), 3)] {
				lines = append(lines, fmt.Sprintf("[%s] %s/%d %s", item.Level, item.Provider, item.EventID, truncateAlertMessage(item.Message, 140)))
			}
			_ = s.db.CreateAlert(ctx, &report.AgentID, "critical_event", "critical",
				fmt.Sprintf("Critical event log entries detected: %d", len(report.EventLogs)),
				strings.Join(lines, "\n"))
		}
	}
}

func isCriticalService(name string) bool {
	critical := []string{"sshd", "ssh", "ntpd", "chronyd", "auditd", "firewalld", "ufw"}
	for _, c := range critical {
		if name == c {
			return true
		}
	}
	return false
}

func minAlertPreview(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func truncateAlertMessage(value string, limit int) string {
	normalized := strings.Join(strings.Fields(value), " ")
	if len(normalized) <= limit {
		return normalized
	}
	return normalized[:limit-3] + "..."
}
