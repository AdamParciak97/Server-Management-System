package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type AuditEntry struct {
	ID         string          `json:"id"`
	UserID     *string         `json:"user_id,omitempty"`
	Username   string          `json:"username"`
	IP         string          `json:"ip"`
	Action     string          `json:"action"`
	Resource   string          `json:"resource,omitempty"`
	ResourceID string          `json:"resource_id,omitempty"`
	Details    json.RawMessage `json:"details,omitempty"`
	Result     string          `json:"result"`
	CreatedAt  time.Time       `json:"created_at"`
}

func (d *DB) WriteAudit(ctx context.Context, userID *string, username, ip, action, resource, resourceID, result string, details interface{}) error {
	id := uuid.New().String()
	var detailsJSON []byte
	if details != nil {
		detailsJSON, _ = json.Marshal(details)
	}
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO audit_log (id, user_id, username, ip, action, resource, resource_id, details, result)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		id, userID, username, ip, action, resource, resourceID, detailsJSON, result)
	return err
}

func (d *DB) ListAudit(ctx context.Context, userID, action string, from, to time.Time, limit int) ([]*AuditEntry, error) {
	if limit <= 0 {
		limit = 200
	}
	query := `
		SELECT id, user_id, COALESCE(username,''), COALESCE(ip,''), action,
			COALESCE(resource,''), COALESCE(resource_id,''), details, result, created_at
		FROM audit_log WHERE 1=1`
	args := []interface{}{}
	n := 1

	if userID != "" {
		query += ` AND user_id = $` + itoa(n)
		args = append(args, userID)
		n++
	}
	if action != "" {
		query += ` AND action = $` + itoa(n)
		args = append(args, action)
		n++
	}
	if !from.IsZero() {
		query += ` AND created_at >= $` + itoa(n)
		args = append(args, from)
		n++
	}
	if !to.IsZero() {
		query += ` AND created_at <= $` + itoa(n)
		args = append(args, to)
		n++
	}

	query += ` ORDER BY created_at DESC LIMIT $` + itoa(n)
	args = append(args, limit)

	rows, err := d.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []*AuditEntry
	for rows.Next() {
		var e AuditEntry
		err := rows.Scan(&e.ID, &e.UserID, &e.Username, &e.IP,
			&e.Action, &e.Resource, &e.ResourceID, &e.Details, &e.Result, &e.CreatedAt)
		if err != nil {
			return nil, err
		}
		entries = append(entries, &e)
	}
	return entries, rows.Err()
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return fmt.Sprintf("%d", n)
}
