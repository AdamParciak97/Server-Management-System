package api

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/smtp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

type reportSMTPSettings struct {
	Enabled  bool
	Host     string
	Port     int
	Username string
	Password string
	From     string
	To       []string
}

func (s *Server) handleEmailReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Recipients []string `json:"recipients"`
		Subject    string   `json:"subject"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	report, err := s.db.GetReport(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "report not found")
		return
	}
	agent, _ := s.db.GetAgent(r.Context(), report.AgentID)

	settings, err := s.loadReportSMTPSettings(r.Context())
	if err != nil {
		s.logger.Error("load smtp settings", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to load smtp settings")
		return
	}
	if !settings.Enabled || settings.Host == "" || settings.From == "" {
		respondError(w, http.StatusBadRequest, "smtp alerting is not configured")
		return
	}

	recipients := normalizeRecipients(req.Recipients)
	if len(recipients) == 0 {
		recipients = settings.To
	}
	if len(recipients) == 0 {
		respondError(w, http.StatusBadRequest, "no recipients configured")
		return
	}

	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		hostname := report.AgentID
		if agent != nil && agent.Hostname != "" {
			hostname = agent.Hostname
		}
		subject = fmt.Sprintf("SMS report: %s (%s)", hostname, report.Timestamp.UTC().Format("2006-01-02 15:04 UTC"))
	}

	htmlBody, textBody := renderReportEmail(report, agent)
	if err := sendSMTPMessage(settings, recipients, subject, textBody, htmlBody); err != nil {
		s.logger.Error("send report email", "report_id", id, "error", err)
		respondError(w, http.StatusInternalServerError, "failed to send email")
		return
	}

	respondOK(w, map[string]interface{}{
		"status":     "sent",
		"recipients": recipients,
	})
}

func (s *Server) loadReportSMTPSettings(ctx context.Context) (reportSMTPSettings, error) {
	values, err := s.db.GetAllSystemConfig(ctx)
	if err != nil {
		return reportSMTPSettings{}, err
	}
	port, _ := strconv.Atoi(values["smtp_port"])
	if port == 0 {
		port = 587
	}
	return reportSMTPSettings{
		Enabled:  strings.EqualFold(values["smtp_enabled"], "true"),
		Host:     values["smtp_host"],
		Port:     port,
		Username: values["smtp_username"],
		Password: values["smtp_password"],
		From:     values["smtp_from"],
		To:       normalizeRecipients(strings.Split(values["smtp_to"], ",")),
	}, nil
}

func normalizeRecipients(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func sendSMTPMessage(settings reportSMTPSettings, recipients []string, subject, textBody, htmlBody string) error {
	address := net.JoinHostPort(settings.Host, strconv.Itoa(settings.Port))
	client, err := smtp.Dial(address)
	if err != nil {
		return err
	}
	defer client.Close()

	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: settings.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if settings.Username != "" {
		auth := smtp.PlainAuth("", settings.Username, settings.Password, settings.Host)
		if err := client.Auth(auth); err != nil {
			return err
		}
	}
	if err := client.Mail(settings.From); err != nil {
		return err
	}
	for _, recipient := range recipients {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}

	writer, err := client.Data()
	if err != nil {
		return err
	}
	boundary := "sms-report-boundary"
	message := strings.Join([]string{
		fmt.Sprintf("From: %s", settings.From),
		fmt.Sprintf("To: %s", strings.Join(recipients, ", ")),
		fmt.Sprintf("Subject: %s", subject),
		"MIME-Version: 1.0",
		fmt.Sprintf("Content-Type: multipart/alternative; boundary=%s", boundary),
		"",
		fmt.Sprintf("--%s", boundary),
		"Content-Type: text/plain; charset=UTF-8",
		"",
		textBody,
		fmt.Sprintf("--%s", boundary),
		"Content-Type: text/html; charset=UTF-8",
		"",
		htmlBody,
		fmt.Sprintf("--%s--", boundary),
	}, "\r\n")

	if _, err := writer.Write([]byte(message)); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func renderReportEmail(report *db.Report, agent *db.Agent) (string, string) {
	system := shared.SystemInfo{}
	services := []shared.Service{}
	packages := []shared.Package{}
	securityAgents := []shared.SecurityAgent{}
	eventLogs := []shared.EventLogEntry{}
	scheduledTasks := []shared.ScheduledTask{}
	_ = json.Unmarshal(report.System, &system)
	_ = json.Unmarshal(report.Services, &services)
	_ = json.Unmarshal(report.Packages, &packages)
	_ = json.Unmarshal(report.SecurityAgents, &securityAgents)
	_ = json.Unmarshal(report.EventLogs, &eventLogs)
	_ = json.Unmarshal(report.ScheduledTasks, &scheduledTasks)

	hostname := system.Hostname
	if hostname == "" && agent != nil {
		hostname = agent.Hostname
	}
	if hostname == "" {
		hostname = report.AgentID
	}
	activeSecurity := 0
	for _, item := range securityAgents {
		switch strings.ToLower(item.Status) {
		case "running", "healthy", "installed", "detected":
			activeSecurity++
		}
	}
	stoppedServices := 0
	for _, item := range services {
		switch strings.ToLower(item.Status) {
		case "stopped", "inactive", "failed":
			stoppedServices++
		}
	}

	var sb strings.Builder
	sb.WriteString("<html><body style=\"font-family:Segoe UI,Arial,sans-serif;background:#0f1117;color:#e2e8f0;padding:24px\">")
	sb.WriteString("<div style=\"max-width:980px;margin:0 auto\">")
	sb.WriteString("<h2 style=\"margin:0 0 12px;color:#4f8ef7\">SMS Report</h2>")
	sb.WriteString("<div style=\"background:#1a1d27;border:1px solid #2e3347;border-radius:12px;padding:18px\">")
	sb.WriteString("<p style=\"margin:0 0 8px\"><strong>Host:</strong> " + html.EscapeString(hostname) + "</p>")
	sb.WriteString("<p style=\"margin:0 0 8px\"><strong>Timestamp:</strong> " + html.EscapeString(report.Timestamp.UTC().Format("2006-01-02 15:04:05 UTC")) + "</p>")
	sb.WriteString("<p style=\"margin:0 0 8px\"><strong>OS:</strong> " + html.EscapeString(strings.TrimSpace(system.OS+" "+system.OSVersion)) + "</p>")
	sb.WriteString("<p style=\"margin:0 0 8px\"><strong>IPs:</strong> " + html.EscapeString(strings.Join(system.IPs, ", ")) + "</p>")
	sb.WriteString("<div style=\"display:flex;gap:12px;flex-wrap:wrap;margin:18px 0\">")
	sb.WriteString(reportEmailStat("CPU", formatReportPercent(system.CPUUsage)))
	sb.WriteString(reportEmailStat("Memory", formatReportPercent(system.MemUsage)))
	sb.WriteString(reportEmailStat("Services", fmt.Sprintf("%d total / %d stopped", len(services), stoppedServices)))
	sb.WriteString(reportEmailStat("Packages", strconv.Itoa(len(packages))))
	sb.WriteString(reportEmailStat("Critical events", strconv.Itoa(len(eventLogs))))
	sb.WriteString(reportEmailStat("Scheduled tasks", strconv.Itoa(len(scheduledTasks))))
	sb.WriteString(reportEmailStat("Security agents", fmt.Sprintf("%d active", activeSecurity)))
	sb.WriteString("</div>")
	if system.WindowsLicense != nil {
		sb.WriteString("<h3 style=\"margin:18px 0 8px\">Windows License</h3>")
		sb.WriteString("<p style=\"margin:0 0 6px\"><strong>Status:</strong> " + html.EscapeString(system.WindowsLicense.LicenseStatus) + "</p>")
		sb.WriteString("<p style=\"margin:0 0 6px\"><strong>Channel:</strong> " + html.EscapeString(system.WindowsLicense.Channel) + "</p>")
		if system.WindowsLicense.ProductName != "" {
			sb.WriteString("<p style=\"margin:0 0 6px\"><strong>Product:</strong> " + html.EscapeString(system.WindowsLicense.ProductName) + "</p>")
		}
		if system.WindowsLicense.KMSMachine != "" {
			sb.WriteString("<p style=\"margin:0 0 6px\"><strong>KMS:</strong> " + html.EscapeString(system.WindowsLicense.KMSMachine) + ":" + html.EscapeString(system.WindowsLicense.KMSPort) + "</p>")
		}
	}
	if len(eventLogs) > 0 {
		sb.WriteString("<h3 style=\"margin:18px 0 8px\">Critical Event Log Entries</h3><ul>")
		for _, item := range eventLogs[:minInt(len(eventLogs), 10)] {
			sb.WriteString("<li style=\"margin-bottom:8px\"><strong>" + html.EscapeString(item.Level) + "</strong> " + html.EscapeString(item.Provider) + " #" + html.EscapeString(strconv.Itoa(item.EventID)) + " at " + html.EscapeString(item.TimeCreated.UTC().Format("2006-01-02 15:04:05")) + "<br>" + html.EscapeString(truncateReportText(item.Message, 240)) + "</li>")
		}
		sb.WriteString("</ul>")
	}
	sb.WriteString("</div></div></body></html>")

	textLines := []string{
		"SMS Report",
		"",
		"Host: " + hostname,
		"Timestamp: " + report.Timestamp.UTC().Format("2006-01-02 15:04:05 UTC"),
		"OS: " + strings.TrimSpace(system.OS+" "+system.OSVersion),
		"IPs: " + strings.Join(system.IPs, ", "),
		fmt.Sprintf("CPU: %s", formatReportPercent(system.CPUUsage)),
		fmt.Sprintf("Memory: %s", formatReportPercent(system.MemUsage)),
		fmt.Sprintf("Services: %d total / %d stopped", len(services), stoppedServices),
		fmt.Sprintf("Packages: %d", len(packages)),
		fmt.Sprintf("Critical events: %d", len(eventLogs)),
		fmt.Sprintf("Scheduled tasks: %d", len(scheduledTasks)),
	}
	if system.WindowsLicense != nil {
		textLines = append(textLines,
			"",
			"Windows License:",
			"Status: "+system.WindowsLicense.LicenseStatus,
			"Channel: "+system.WindowsLicense.Channel,
		)
	}
	return sb.String(), strings.Join(textLines, "\n")
}

func reportEmailStat(label, value string) string {
	return `<div style="min-width:140px;flex:1 1 140px;background:#252836;border:1px solid #2e3347;border-radius:10px;padding:12px"><div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em">` + html.EscapeString(label) + `</div><div style="font-size:20px;font-weight:700;margin-top:6px">` + html.EscapeString(value) + `</div></div>`
}

func truncateReportText(value string, limit int) string {
	normalized := strings.Join(strings.Fields(value), " ")
	if len(normalized) <= limit {
		return normalized
	}
	return normalized[:limit-3] + "..."
}

func formatReportPercent(value float64) string {
	if value <= 0 {
		return "0.0%"
	}
	return fmt.Sprintf("%.1f%%", value)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
