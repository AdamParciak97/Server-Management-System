package db

import (
	"context"
	"encoding/json"
	"time"
)

type CommandTemplate struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	Description    string                 `json:"description,omitempty"`
	Type           string                 `json:"type"`
	Priority       string                 `json:"priority"`
	Payload        map[string]interface{} `json:"payload"`
	DryRun         bool                   `json:"dry_run"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
	CreatedBy      *string                `json:"created_by,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
}

func (d *DB) CreateCommandTemplate(ctx context.Context, item *CommandTemplate) (*CommandTemplate, error) {
	var payload []byte
	if item.Payload != nil {
		payload, _ = json.Marshal(item.Payload)
	} else {
		payload = []byte("{}")
	}

	row := d.Pool.QueryRow(ctx, `
		INSERT INTO command_templates
			(name, description, type, priority, payload, dry_run, timeout_seconds, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, name, COALESCE(description,''), type, priority, payload, dry_run, timeout_seconds, created_by, created_at`,
		item.Name, item.Description, item.Type, item.Priority, payload, item.DryRun, item.TimeoutSeconds, item.CreatedBy)

	return scanCommandTemplate(row)
}

func (d *DB) ListCommandTemplates(ctx context.Context) ([]*CommandTemplate, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, name, COALESCE(description,''), type, priority, payload, dry_run, timeout_seconds, created_by, created_at
		FROM command_templates
		ORDER BY name ASC, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*CommandTemplate
	for rows.Next() {
		item, err := scanCommandTemplate(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (d *DB) DeleteCommandTemplate(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM command_templates WHERE id = $1`, id)
	return err
}

func scanCommandTemplate(row scannable) (*CommandTemplate, error) {
	var item CommandTemplate
	var payloadJSON []byte
	if err := row.Scan(
		&item.ID, &item.Name, &item.Description, &item.Type, &item.Priority,
		&payloadJSON, &item.DryRun, &item.TimeoutSeconds, &item.CreatedBy, &item.CreatedAt,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(payloadJSON, &item.Payload)
	if item.Payload == nil {
		item.Payload = map[string]interface{}{}
	}
	return &item, nil
}
