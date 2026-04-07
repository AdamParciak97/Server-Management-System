package alerting

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
)

type smtpSettings struct {
	Enabled  bool
	Host     string
	Port     int
	Username string
	Password string
	From     string
	To       []string
}

func (m *Monitor) loadSMTPSettings(ctx context.Context) (smtpSettings, error) {
	values, err := m.db.GetAllSystemConfig(ctx)
	if err != nil {
		return smtpSettings{}, err
	}
	port, _ := strconv.Atoi(values["smtp_port"])
	if port == 0 {
		port = 587
	}
	recipients := []string{}
	for _, item := range strings.Split(values["smtp_to"], ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			recipients = append(recipients, trimmed)
		}
	}
	return smtpSettings{
		Enabled:  strings.EqualFold(values["smtp_enabled"], "true"),
		Host:     values["smtp_host"],
		Port:     port,
		Username: values["smtp_username"],
		Password: values["smtp_password"],
		From:     values["smtp_from"],
		To:       recipients,
	}, nil
}

func (m *Monitor) dispatchPendingAlerts(ctx context.Context) {
	settings, err := m.loadSMTPSettings(ctx)
	if err != nil || !settings.Enabled || settings.Host == "" || len(settings.To) == 0 || settings.From == "" {
		return
	}

	alerts, err := m.db.ListAlertsPendingNotification(ctx, 50)
	if err != nil || len(alerts) == 0 {
		return
	}

	for _, alert := range alerts {
		if err := sendSMTPAlert(settings, alert.Hostname, alert.Title, alert.Message, alert.Severity, alert.CreatedAt.UTC().Format("2006-01-02 15:04:05 UTC")); err != nil {
			m.logger.Error("send alert email", "alert_id", alert.ID, "error", err)
			_ = m.db.SetAlertNotificationError(ctx, alert.ID, err.Error())
			continue
		}
		_ = m.db.MarkAlertNotified(ctx, alert.ID)
	}
}

func sendSMTPAlert(settings smtpSettings, hostname, title, body, severity, createdAt string) error {
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
	for _, recipient := range settings.To {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}

	subject := fmt.Sprintf("[SMS][%s] %s", strings.ToUpper(severity), title)
	message := strings.Join([]string{
		fmt.Sprintf("From: %s", settings.From),
		fmt.Sprintf("To: %s", strings.Join(settings.To, ", ")),
		fmt.Sprintf("Subject: %s", subject),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		fmt.Sprintf("Server: %s", hostname),
		fmt.Sprintf("Severity: %s", severity),
		fmt.Sprintf("Created: %s", createdAt),
		"",
		body,
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
