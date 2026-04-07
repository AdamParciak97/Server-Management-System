package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type Alert struct {
	ID             string     `json:"id"`
	AgentID        *string    `json:"agent_id,omitempty"`
	Hostname       string     `json:"hostname,omitempty"`
	Type           string     `json:"type"`
	Severity       string     `json:"severity"`
	Title          string     `json:"title"`
	Message        string     `json:"message"`
	Acknowledged   bool       `json:"acknowledged"`
	AcknowledgedBy *string    `json:"acknowledged_by,omitempty"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
	Resolved       bool       `json:"resolved"`
	ResolvedAt     *time.Time `json:"resolved_at,omitempty"`
	NotifiedAt     *time.Time `json:"notified_at,omitempty"`
	NotificationError string  `json:"notification_error,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

func (d *DB) CreateAlert(ctx context.Context, agentID *string, alertType, severity, title, message string) error {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO alerts (id, agent_id, type, severity, title, message)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		id, agentID, alertType, severity, title, message)
	return err
}

func (d *DB) AlertExists(ctx context.Context, agentID *string, alertType string) (bool, error) {
	var count int
	err := d.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM alerts
		WHERE ($1::uuid IS NULL OR agent_id = $1)
		  AND type = $2
		  AND acknowledged = false
		  AND resolved = false`,
		agentID, alertType).Scan(&count)
	return count > 0, err
}

func (d *DB) ListAlerts(ctx context.Context, onlyActive bool) ([]*Alert, error) {
	query := `
		SELECT a.id, a.agent_id, COALESCE(ag.hostname,''), a.type, a.severity,
			a.title, a.message, a.acknowledged, a.acknowledged_by, a.acknowledged_at,
			a.resolved, a.resolved_at, a.notified_at, COALESCE(a.notification_error,''), a.created_at
		FROM alerts a
		LEFT JOIN agents ag ON a.agent_id = ag.id`
	if onlyActive {
		query += ` WHERE a.acknowledged = false AND a.resolved = false`
	}
	query += ` ORDER BY a.created_at DESC LIMIT 500`

	rows, err := d.Pool.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var alerts []*Alert
	for rows.Next() {
		var al Alert
		err := rows.Scan(&al.ID, &al.AgentID, &al.Hostname, &al.Type, &al.Severity,
			&al.Title, &al.Message, &al.Acknowledged, &al.AcknowledgedBy,
			&al.AcknowledgedAt, &al.Resolved, &al.ResolvedAt, &al.NotifiedAt, &al.NotificationError, &al.CreatedAt)
		if err != nil {
			return nil, err
		}
		alerts = append(alerts, &al)
	}
	return alerts, rows.Err()
}

func (d *DB) ListAlertsPendingNotification(ctx context.Context, limit int) ([]*Alert, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT a.id, a.agent_id, COALESCE(ag.hostname,''), a.type, a.severity,
			a.title, a.message, a.acknowledged, a.acknowledged_by, a.acknowledged_at,
			a.resolved, a.resolved_at, a.notified_at, COALESCE(a.notification_error,''), a.created_at
		FROM alerts a
		LEFT JOIN agents ag ON a.agent_id = ag.id
		WHERE a.notified_at IS NULL
		ORDER BY a.created_at ASC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var alerts []*Alert
	for rows.Next() {
		var al Alert
		err := rows.Scan(&al.ID, &al.AgentID, &al.Hostname, &al.Type, &al.Severity,
			&al.Title, &al.Message, &al.Acknowledged, &al.AcknowledgedBy,
			&al.AcknowledgedAt, &al.Resolved, &al.ResolvedAt, &al.NotifiedAt, &al.NotificationError, &al.CreatedAt)
		if err != nil {
			return nil, err
		}
		alerts = append(alerts, &al)
	}
	return alerts, rows.Err()
}

func (d *DB) MarkAlertNotified(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE alerts
		SET notified_at = NOW(),
			notification_error = ''
		WHERE id = $1`, id)
	return err
}

func (d *DB) SetAlertNotificationError(ctx context.Context, id, msg string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE alerts
		SET notification_error = $2
		WHERE id = $1`, id, msg)
	return err
}

func (d *DB) AcknowledgeAlert(ctx context.Context, id, userID string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE alerts SET acknowledged = true, acknowledged_by = $2, acknowledged_at = NOW()
		WHERE id = $1`, id, userID)
	return err
}

func (d *DB) ResolveAlert(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE alerts SET resolved = true, resolved_at = NOW() WHERE id = $1`, id)
	return err
}

func (d *DB) CountActiveAlerts(ctx context.Context) (int, error) {
	var count int
	err := d.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM alerts WHERE acknowledged = false AND resolved = false`).Scan(&count)
	return count, err
}
