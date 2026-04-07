package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

func (s *Server) handleListServers(w http.ResponseWriter, r *http.Request) {
	agents, err := s.db.ListAgents(r.Context())
	if err != nil {
		s.logger.Error("list agents", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to list servers")
		return
	}
	if agents == nil {
		agents = nil // will be empty JSON array
	}
	respondOK(w, s.filterAgentsByScope(s.getClaims(r.Context()), agents))
}

func (s *Server) handleGetServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	respondOK(w, agent)
}

func (s *Server) handleServerHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	history, err := s.db.GetReportHistory(r.Context(), id, limit)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to get history")
		return
	}
	respondOK(w, history)
}

func (s *Server) handleServerTimeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}

	type TimelineEntry struct {
		Timestamp  time.Time              `json:"timestamp"`
		Category   string                 `json:"category"`
		Status     string                 `json:"status"`
		Title      string                 `json:"title"`
		Message    string                 `json:"message,omitempty"`
		ResourceID string                 `json:"resource_id,omitempty"`
		Details    map[string]interface{} `json:"details,omitempty"`
	}

	entries := make([]TimelineEntry, 0, limit*2)

	if reports, err := s.db.GetReportHistory(r.Context(), id, limit); err == nil {
		for _, report := range reports {
			var system shared.SystemInfo
			_ = json.Unmarshal(report.System, &system)
			entries = append(entries, TimelineEntry{
				Timestamp:  report.Timestamp,
				Category:   "report",
				Status:     "success",
				Title:      "Inventory report received",
				Message:    fmt.Sprintf("%s %s", strings.TrimSpace(system.OS), strings.TrimSpace(system.OSVersion)),
				ResourceID: report.ID,
				Details: map[string]interface{}{
					"report_id": report.ID,
				},
			})
		}
	}

	if commands, err := s.db.ListCommands(r.Context(), id, limit); err == nil {
		for _, cmd := range commands {
			eventAt := cmd.CompletedAt
			if eventAt == nil {
				eventAt = cmd.SentAt
			}
			if eventAt == nil {
				eventAt = &cmd.CreatedAt
			}
			title := "Command queued"
			switch cmd.Status {
			case "success":
				title = "Command completed"
			case "error", "timeout", "cancelled":
				title = "Command failed"
			case "sent", "running":
				title = "Command in progress"
			}
			entries = append(entries, TimelineEntry{
				Timestamp:  *eventAt,
				Category:   "command",
				Status:     cmd.Status,
				Title:      title,
				Message:    fmt.Sprintf("%s (%s)", cmd.Type, cmd.Priority),
				ResourceID: cmd.ID,
				Details: map[string]interface{}{
					"type":       cmd.Type,
					"priority":   cmd.Priority,
					"created_at": cmd.CreatedAt,
					"status":     cmd.Status,
				},
			})
		}
	}

	if alerts, err := s.db.ListAlerts(r.Context(), false); err == nil {
		for _, alert := range alerts {
			if alert.AgentID == nil || *alert.AgentID != id {
				continue
			}
			status := "active"
			if alert.Resolved {
				status = "resolved"
			} else if alert.Acknowledged {
				status = "acknowledged"
			}
			entries = append(entries, TimelineEntry{
				Timestamp:  alert.CreatedAt,
				Category:   "alert",
				Status:     status,
				Title:      alert.Title,
				Message:    alert.Message,
				ResourceID: alert.ID,
				Details: map[string]interface{}{
					"severity": alert.Severity,
					"type":     alert.Type,
				},
			})
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp.After(entries[j].Timestamp)
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}
	respondOK(w, entries)
}

func (s *Server) handleGetBaseline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	item, err := s.db.GetAgentBaseline(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "baseline not found")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleSetBaseline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	var req struct {
		ReportID string `json:"report_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ReportID == "" {
		respondError(w, http.StatusBadRequest, "report_id required")
		return
	}
	report, err := s.db.GetReport(r.Context(), req.ReportID)
	if err != nil || report.AgentID != id {
		respondError(w, http.StatusBadRequest, "report not found for this server")
		return
	}
	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}
	if err := s.db.SetAgentBaseline(r.Context(), id, req.ReportID, createdBy); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to save baseline")
		return
	}
	item, err := s.db.GetAgentBaseline(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load baseline")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleConfigDiff(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")

	diff, err := s.db.GetConfigDiff(r.Context(), id, from, to)
	if err != nil {
		respondError(w, http.StatusNotFound, "diff not found")
		return
	}
	respondOK(w, diff)
}

func (s *Server) handleForceReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	user := getUserFromCtx(r.Context())

	cmd := shared.Command{
		Type:     shared.CmdForceReport,
		Priority: shared.PriorityCritical,
		Timeout:  60,
	}

	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	_, err = s.db.CreateCommand(r.Context(), &id, nil, cmd, createdBy)
	if err != nil {
		s.logger.Error("force report", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create command")
		return
	}
	respondOK(w, map[string]string{"status": "queued"})
}

func (s *Server) handleAssignGroup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := s.db.GetAgent(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	var req struct {
		GroupID string `json:"group_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.GroupID != "" && !s.canAccessGroup(s.getClaims(r.Context()), &req.GroupID) {
		respondError(w, http.StatusForbidden, "target group outside allowed scope")
		return
	}
	if err := s.db.AssignAgentToGroup(r.Context(), id, req.GroupID); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to assign group")
		return
	}
	respondOK(w, map[string]string{"status": "ok"})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	agents, _ := s.db.ListAgents(ctx)
	agents = s.filterAgentsByScope(s.getClaims(r.Context()), agents)
	totalServers := len(agents)
	onlineServers := 0
	offlineServers := 0
	for _, a := range agents {
		switch a.Status {
		case "online":
			onlineServers++
		case "offline":
			offlineServers++
		}
	}

	activeAlerts, _ := s.db.CountActiveAlerts(ctx)
	baselineCount, _ := s.db.CountAgentBaselines(ctx)

	licenseChannels := map[string]int{}
	licenseStatuses := map[string]int{}
	totalScheduledTasks := 0
	licensedWindows := 0
	windowsAssets := []map[string]interface{}{}
	pendingUpdatesServers := 0
	pendingRebootServers := 0
	serviceRoles := map[string]int{}
	serviceMap := []map[string]interface{}{}
	dependencyEdges := map[string]int{}
	bitlockerRiskServers := 0
	rdpEnabledServers := 0
	winrmEnabledServers := 0
	sshEnabledServers := 0
	expiringCertificates := 0

	for _, agent := range agents {
		latest, err := s.db.GetLatestReport(ctx, agent.ID)
		if err != nil || latest == nil {
			continue
		}
		var system shared.SystemInfo
		var scheduledTasks []shared.ScheduledTask
		var services []shared.Service
		_ = json.Unmarshal(latest.System, &system)
		_ = json.Unmarshal(latest.ScheduledTasks, &scheduledTasks)
		_ = json.Unmarshal(latest.Services, &services)
		totalScheduledTasks += len(scheduledTasks)
		if system.WindowsUpdate != nil {
			if system.WindowsUpdate.PendingUpdates > 0 {
				pendingUpdatesServers++
			}
			if system.WindowsUpdate.PendingReboot {
				pendingRebootServers++
			}
		}
		if system.SecurityPosture != nil {
			if hasBitLockerRisk(system.SecurityPosture) {
				bitlockerRiskServers++
			}
			if system.SecurityPosture.RDPEnabled {
				rdpEnabledServers++
			}
			if system.SecurityPosture.WinRMEnabled {
				winrmEnabledServers++
			}
			if system.SecurityPosture.SSHEnabled {
				sshEnabledServers++
			}
			for _, cert := range system.SecurityPosture.Certificates {
				if cert.DaysLeft >= 0 && cert.DaysLeft <= 30 {
					expiringCertificates++
				}
			}
		}
		roles := detectServiceRoles(system, services)
		for _, role := range roles {
			serviceRoles[role]++
		}
		if len(roles) > 0 {
			serviceMap = append(serviceMap, map[string]interface{}{
				"agent_id":  agent.ID,
				"hostname":  agent.Hostname,
				"group_id":  agent.GroupID,
				"group_name": agent.GroupName,
				"roles":     roles,
			})
			roleSet := map[string]bool{}
			for _, role := range roles {
				roleSet[role] = true
			}
			if (roleSet["iis"] || roleSet["apache"] || roleSet["nginx"]) && (roleSet["postgresql"] || roleSet["mysql"] || roleSet["mssql"]) {
				dependencyEdges["web->db"]++
			}
			if roleSet["active_directory"] && roleSet["dns"] {
				dependencyEdges["ad->dns"]++
			}
		}

		if system.WindowsLicense != nil {
			channel := strings.TrimSpace(system.WindowsLicense.Channel)
			if channel == "" {
				channel = "Unknown"
			}
			status := strings.TrimSpace(system.WindowsLicense.LicenseStatus)
			if status == "" {
				status = "Unknown"
			}
			licenseChannels[channel]++
			licenseStatuses[status]++
			if strings.EqualFold(status, "Licensed") {
				licensedWindows++
			}
			windowsAssets = append(windowsAssets, map[string]interface{}{
				"agent_id":             agent.ID,
				"hostname":             agent.Hostname,
				"channel":              channel,
				"license_status":       status,
				"product_name":         system.WindowsLicense.ProductName,
				"partial_product_key":  system.WindowsLicense.PartialProductKey,
				"kms_machine":          system.WindowsLicense.KMSMachine,
				"kms_port":             system.WindowsLicense.KMSPort,
				"scheduled_tasks":      len(scheduledTasks),
				"os_version":           system.OSVersion,
			})
		}
	}

	respondOK(w, map[string]interface{}{
		"total_servers":          totalServers,
		"online_servers":         onlineServers,
		"offline_servers":        offlineServers,
		"active_alerts":          activeAlerts,
		"baseline_count":         baselineCount,
		"licensed_windows":       licensedWindows,
		"scheduled_tasks_total":  totalScheduledTasks,
		"pending_updates_servers": pendingUpdatesServers,
		"pending_reboot_servers": pendingRebootServers,
		"license_channels":       licenseChannels,
		"license_statuses":       licenseStatuses,
		"windows_assets":         windowsAssets,
		"service_roles":          serviceRoles,
		"service_map":            serviceMap,
		"dependency_edges":       dependencyEdges,
		"bitlocker_risk_servers": bitlockerRiskServers,
		"rdp_enabled_servers":    rdpEnabledServers,
		"winrm_enabled_servers":  winrmEnabledServers,
		"ssh_enabled_servers":    sshEnabledServers,
		"expiring_certificates":  expiringCertificates,
	})
}

func hasBitLockerRisk(posture *shared.SecurityPosture) bool {
	if posture == nil || len(posture.BitLockerVolumes) == 0 {
		return false
	}
	for _, volume := range posture.BitLockerVolumes {
		status := strings.ToLower(strings.TrimSpace(volume.ProtectionStatus))
		if status == "" || strings.Contains(status, "off") || strings.Contains(status, "unprotected") {
			return true
		}
	}
	return false
}

func detectServiceRoles(system shared.SystemInfo, services []shared.Service) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(role string) {
		if role != "" && !seen[role] {
			seen[role] = true
			out = append(out, role)
		}
	}

	for _, service := range services {
		name := strings.ToLower(service.Name)
		display := strings.ToLower(service.DisplayName)
		switch {
		case strings.Contains(name, "w3svc") || strings.Contains(display, "world wide web") || strings.Contains(display, "iis"):
			add("iis")
		case strings.Contains(name, "apache"):
			add("apache")
		case strings.Contains(name, "nginx"):
			add("nginx")
		case strings.Contains(name, "postgres"):
			add("postgresql")
		case strings.Contains(name, "mysql") || strings.Contains(name, "mariadb"):
			add("mysql")
		case strings.Contains(name, "mssql") || strings.Contains(display, "sql server"):
			add("mssql")
		case strings.Contains(name, "named") || strings.Contains(name, "dns"):
			add("dns")
		case strings.Contains(name, "ntds") || strings.Contains(display, "active directory"):
			add("active_directory")
		}
	}
	if strings.Contains(strings.ToLower(system.OS), "windows") {
		for _, service := range services {
			if strings.EqualFold(service.Name, "NTDS") {
				add("active_directory")
			}
			if strings.EqualFold(service.Name, "DNS") || strings.EqualFold(service.Name, "DNS Server") {
				add("dns")
			}
		}
	}
	return out
}

func (s *Server) handleCompliance(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list agents")
		return
	}
	agents = s.filterAgentsByScope(s.getClaims(r.Context()), agents)

	type ComplianceEntry struct {
		AgentID         string             `json:"agent_id"`
		Hostname        string             `json:"hostname"`
		GroupID         *string            `json:"group_id,omitempty"`
		GroupName       string             `json:"group_name,omitempty"`
		Status          string             `json:"status"`
		RequiredAgents  []string           `json:"required_agents"`
		MissingAgents   []string           `json:"missing_agents"`
		PolicyResults   []PolicyResult     `json:"policy_results"`
		FailedPolicies  []PolicyResult     `json:"failed_policies"`
		Exceptions      []ComplianceExceptionView `json:"exceptions"`
		Compliant       bool               `json:"compliant"`
		LastReportAt    string             `json:"last_report_at,omitempty"`
	}

	type reportData struct {
		System         shared.SystemInfo
		Services       []shared.Service
		Packages       []shared.Package
		SecurityAgents []shared.SecurityAgent
	}

	var entries []ComplianceEntry
	policies, _ := s.db.ListCompliancePolicies(ctx)
	exceptions, _ := s.db.ListComplianceExceptions(ctx)
	for _, agent := range agents {
		entry := ComplianceEntry{
			AgentID:        agent.ID,
			Hostname:       agent.Hostname,
			GroupID:        agent.GroupID,
			GroupName:      agent.GroupName,
			Status:         agent.Status,
			Compliant:      true,
			RequiredAgents: []string{},
			MissingAgents:  []string{},
			PolicyResults:  []PolicyResult{},
			FailedPolicies: []PolicyResult{},
			Exceptions:     []ComplianceExceptionView{},
		}

		data := reportData{}
		if latest, err := s.db.GetLatestReport(ctx, agent.ID); err == nil && latest != nil {
			entry.LastReportAt = latest.Timestamp.Format("2006-01-02T15:04:05Z07:00")
			_ = json.Unmarshal(latest.System, &data.System)
			_ = json.Unmarshal(latest.Services, &data.Services)
			_ = json.Unmarshal(latest.Packages, &data.Packages)
			_ = json.Unmarshal(latest.SecurityAgents, &data.SecurityAgents)
		}

		if agent.GroupID != nil {
			required, _ := s.db.GetRequiredAgents(ctx, *agent.GroupID)
			if required != nil {
				entry.RequiredAgents = required
			}
			runningSecurityAgents := map[string]bool{}
			for _, securityAgent := range data.SecurityAgents {
				if strings.EqualFold(securityAgent.Status, "running") || strings.EqualFold(securityAgent.Status, "healthy") {
					runningSecurityAgents[strings.ToLower(securityAgent.Name)] = true
				}
			}
			for _, req := range entry.RequiredAgents {
				if !runningSecurityAgents[strings.ToLower(req)] {
					entry.MissingAgents = append(entry.MissingAgents, req)
				}
			}
			if len(entry.MissingAgents) > 0 {
				entry.Compliant = false
			}
		}

		for _, policy := range policies {
			if policy == nil || !policy.Enabled {
				continue
			}
			if policy.GroupID != nil && (agent.GroupID == nil || *policy.GroupID != *agent.GroupID) {
				continue
			}
			result := evaluatePolicy(policy, data.System, data.Services, data.Packages, data.SecurityAgents)
			if matched := findMatchingException(exceptions, policy.ID, agent.ID); matched != nil && !isExceptionExpired(matched) {
				result.Excepted = true
				result.ExceptionReason = matched.Reason
				result.ExceptionID = matched.ID
				result.ExceptionExpiresAt = matched.ExpiresAt
				result.Compliant = true
				result.Message = "Policy exempted: " + matched.Reason
				entry.Exceptions = append(entry.Exceptions, ComplianceExceptionView{
					ID:        matched.ID,
					PolicyID:  matched.PolicyID,
					PolicyName: policy.Name,
					Reason:    matched.Reason,
					ExpiresAt: matched.ExpiresAt,
				})
			}
			entry.PolicyResults = append(entry.PolicyResults, result)
			if !result.Compliant && !result.Excepted {
				entry.FailedPolicies = append(entry.FailedPolicies, result)
				entry.Compliant = false
			}
		}

		entries = append(entries, entry)
	}

	if entries == nil {
		entries = []ComplianceEntry{}
	}
	respondOK(w, entries)
}

type ComplianceExceptionView struct {
	ID         string     `json:"id"`
	PolicyID    string     `json:"policy_id"`
	PolicyName string     `json:"policy_name"`
	Reason     string     `json:"reason"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
}

type PolicyResult struct {
	PolicyID       string `json:"policy_id"`
	Name           string `json:"name"`
	PolicyType     string `json:"policy_type"`
	Subject        string `json:"subject"`
	ExpectedValue  string `json:"expected_value,omitempty"`
	Severity       string `json:"severity"`
	GroupName      string `json:"group_name,omitempty"`
	Compliant      bool   `json:"compliant"`
	Excepted       bool   `json:"excepted"`
	ExceptionID    string `json:"exception_id,omitempty"`
	ExceptionReason string `json:"exception_reason,omitempty"`
	ExceptionExpiresAt *time.Time `json:"exception_expires_at,omitempty"`
	Message        string `json:"message"`
}

func evaluatePolicy(policy *db.CompliancePolicy, system shared.SystemInfo, services []shared.Service, packages []shared.Package, securityAgents []shared.SecurityAgent) PolicyResult {
	result := PolicyResult{
		PolicyID:      policy.ID,
		Name:          policy.Name,
		PolicyType:    policy.PolicyType,
		Subject:       policy.Subject,
		ExpectedValue: policy.ExpectedValue,
		Severity:      policy.Severity,
		GroupName:     policy.GroupName,
		Compliant:     true,
		Message:       "Policy passed",
	}

	switch policy.PolicyType {
	case "service_status":
		expected := strings.ToLower(strings.TrimSpace(policy.ExpectedValue))
		if expected == "" {
			expected = "running"
		}
		for _, service := range services {
			if strings.EqualFold(service.Name, policy.Subject) || strings.EqualFold(service.DisplayName, policy.Subject) {
				actual := strings.ToLower(strings.TrimSpace(service.Status))
				result.Compliant = actual == expected
				if !result.Compliant {
					result.Message = "Expected service " + policy.Subject + " to be " + expected + ", got " + actual
				}
				return result
			}
		}
		result.Compliant = false
		result.Message = "Service not found in latest report"
	case "package_installed":
		for _, pkg := range packages {
			if strings.EqualFold(pkg.Name, policy.Subject) {
				result.Compliant = true
				result.Message = "Package found"
				return result
			}
		}
		result.Compliant = false
		result.Message = "Package not found in latest report"
	case "security_agent":
		for _, agent := range securityAgents {
			if strings.EqualFold(agent.Name, policy.Subject) {
				result.Compliant = strings.EqualFold(agent.Status, "running") || strings.EqualFold(agent.Status, "healthy")
				if !result.Compliant {
					result.Message = "Security agent detected but not healthy/running"
				}
				return result
			}
		}
		result.Compliant = false
		result.Message = "Security agent not found in latest report"
	case "firewall_enabled":
		expected := !strings.EqualFold(strings.TrimSpace(policy.ExpectedValue), "false")
		subject := strings.TrimSpace(policy.Subject)
		if system.WindowsSecurity == nil || len(system.WindowsSecurity.FirewallProfiles) == 0 {
			result.Compliant = false
			result.Message = "Firewall data not found in latest report"
			return result
		}
		matched := false
		for _, profile := range system.WindowsSecurity.FirewallProfiles {
			if subject == "" || strings.EqualFold(subject, "all") || strings.EqualFold(profile.Name, subject) {
				matched = true
				if profile.Enabled != expected {
					result.Compliant = false
					result.Message = "Firewall profile " + profile.Name + " is not in expected state"
					return result
				}
			}
		}
		if !matched {
			result.Compliant = false
			result.Message = "Firewall profile not found in latest report"
		}
	case "defender_status":
		if system.WindowsSecurity == nil {
			result.Compliant = false
			result.Message = "Defender data not found in latest report"
			return result
		}
		result.Compliant = system.WindowsSecurity.DefenderEnabled && system.WindowsSecurity.RealTimeEnabled
		if !result.Compliant {
			result.Message = "Windows Defender is not fully enabled"
		}
	case "patch_compliance":
		if system.WindowsUpdate == nil {
			result.Compliant = false
			result.Message = "Windows Update data not found in latest report"
			return result
		}
		maxPending := 0
		if strings.TrimSpace(policy.ExpectedValue) != "" {
			if parsed, err := strconv.Atoi(strings.TrimSpace(policy.ExpectedValue)); err == nil {
				maxPending = parsed
			}
		}
		result.Compliant = system.WindowsUpdate.PendingUpdates <= maxPending && !system.WindowsUpdate.PendingReboot
		if !result.Compliant {
			result.Message = fmt.Sprintf("Pending updates=%d, pending reboot=%t", system.WindowsUpdate.PendingUpdates, system.WindowsUpdate.PendingReboot)
		}
	case "bitlocker_enabled":
		if system.SecurityPosture == nil || len(system.SecurityPosture.BitLockerVolumes) == 0 {
			result.Compliant = false
			result.Message = "BitLocker data not found in latest report"
			return result
		}
		subject := strings.TrimSpace(policy.Subject)
		matched := false
		for _, volume := range system.SecurityPosture.BitLockerVolumes {
			if subject == "" || strings.EqualFold(subject, "all") || strings.EqualFold(volume.MountPoint, subject) {
				matched = true
				status := strings.ToLower(strings.TrimSpace(volume.ProtectionStatus))
				if status == "" || strings.Contains(status, "off") || strings.Contains(status, "unprotected") {
					result.Compliant = false
					result.Message = "BitLocker not protecting " + volume.MountPoint
					return result
				}
			}
		}
		if !matched {
			result.Compliant = false
			result.Message = "BitLocker volume not found in latest report"
		}
	case "remote_access_disabled":
		if system.SecurityPosture == nil {
			result.Compliant = false
			result.Message = "Remote access posture not found in latest report"
			return result
		}
		target := strings.ToLower(strings.TrimSpace(policy.Subject))
		expectedDisabled := !strings.EqualFold(strings.TrimSpace(policy.ExpectedValue), "false")
		if target == "" || target == "rdp" {
			result.Compliant = system.SecurityPosture.RDPEnabled != expectedDisabled
			if !result.Compliant {
				result.Message = "RDP is enabled"
			}
			return result
		}
		if target == "winrm" {
			result.Compliant = system.SecurityPosture.WinRMEnabled != expectedDisabled
			if !result.Compliant {
				result.Message = "WinRM is enabled"
			}
			return result
		}
		if target == "ssh" {
			result.Compliant = system.SecurityPosture.SSHEnabled != expectedDisabled
			if !result.Compliant {
				result.Message = "SSH is enabled"
			}
			return result
		}
		result.Compliant = false
		result.Message = "Unsupported remote access subject"
	case "local_admin_count":
		if system.SecurityPosture == nil {
			result.Compliant = false
			result.Message = "Local admin data not found in latest report"
			return result
		}
		maxAdmins := 0
		if strings.TrimSpace(policy.ExpectedValue) != "" {
			if parsed, err := strconv.Atoi(strings.TrimSpace(policy.ExpectedValue)); err == nil {
				maxAdmins = parsed
			}
		}
		result.Compliant = len(system.SecurityPosture.LocalAdmins) <= maxAdmins
		if !result.Compliant {
			result.Message = fmt.Sprintf("Local administrators=%d exceeds max=%d", len(system.SecurityPosture.LocalAdmins), maxAdmins)
		}
	case "certificate_expiry":
		if system.SecurityPosture == nil || len(system.SecurityPosture.Certificates) == 0 {
			result.Compliant = false
			result.Message = "Certificate inventory not found in latest report"
			return result
		}
		days := 30
		if strings.TrimSpace(policy.ExpectedValue) != "" {
			if parsed, err := strconv.Atoi(strings.TrimSpace(policy.ExpectedValue)); err == nil {
				days = parsed
			}
		}
		subject := strings.ToLower(strings.TrimSpace(policy.Subject))
		for _, cert := range system.SecurityPosture.Certificates {
			if subject != "" && subject != "all" && !strings.Contains(strings.ToLower(cert.Subject), subject) {
				continue
			}
			if cert.DaysLeft <= days {
				result.Compliant = false
				result.Message = fmt.Sprintf("Certificate %s expires in %d days", cert.Subject, cert.DaysLeft)
				return result
			}
		}
	default:
		result.Message = "Unsupported policy type"
	}

	return result
}

func findMatchingException(items []*db.ComplianceException, policyID, agentID string) *db.ComplianceException {
	for _, item := range items {
		if item.PolicyID == policyID && item.AgentID == agentID {
			return item
		}
	}
	return nil
}

func isExceptionExpired(item *db.ComplianceException) bool {
	return item != nil && item.ExpiresAt != nil && item.ExpiresAt.Before(time.Now())
}

func (s *Server) handleExportReport(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	ctx := r.Context()
	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to get data")
		return
	}

	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", "attachment; filename=servers.csv")
		w.Write([]byte("ID,Hostname,OS,Status,Last Seen,Group\n"))
		for _, a := range agents {
			lastSeen := ""
			if a.LastSeen != nil {
				lastSeen = a.LastSeen.Format("2006-01-02 15:04:05")
			}
			w.Write([]byte(a.ID + "," + a.Hostname + "," + a.OS + "," +
				a.Status + "," + lastSeen + "," + a.GroupName + "\n"))
		}
	default:
		respondError(w, http.StatusBadRequest, "unsupported format, use csv")
	}
}
