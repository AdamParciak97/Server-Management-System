package db

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/sms/server-mgmt/shared"
)

type DBCommand struct {
	ID             string                 `json:"id"`
	AgentID        *string                `json:"agent_id,omitempty"`
	GroupID        *string                `json:"group_id,omitempty"`
	Type           string                 `json:"type"`
	Priority       string                 `json:"priority"`
	Payload        map[string]interface{} `json:"payload"`
	DryRun         bool                   `json:"dry_run"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
	Status         string                 `json:"status"`
	Output         string                 `json:"output,omitempty"`
	Error          string                 `json:"error,omitempty"`
	ExitCode       *int                   `json:"exit_code,omitempty"`
	DurationMs     *int64                 `json:"duration_ms,omitempty"`
	RequiresApproval bool                 `json:"requires_approval"`
	ApprovedBy     *string                `json:"approved_by,omitempty"`
	ApprovedAt     *time.Time             `json:"approved_at,omitempty"`
	ApprovalNote   string                 `json:"approval_note,omitempty"`
	CreatedBy      *string                `json:"created_by,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
	SentAt         *time.Time             `json:"sent_at,omitempty"`
	CompletedAt    *time.Time             `json:"completed_at,omitempty"`
}

type ScheduledCommand struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	CronExpr       string                 `json:"cron_expr"`
	AgentID        *string                `json:"agent_id,omitempty"`
	GroupID        *string                `json:"group_id,omitempty"`
	MaintenanceWindowID *string           `json:"maintenance_window_id,omitempty"`
	MaintenanceWindowName string          `json:"maintenance_window_name,omitempty"`
	Type           string                 `json:"type"`
	Priority       string                 `json:"priority"`
	Payload        map[string]interface{} `json:"payload"`
	DryRun         bool                   `json:"dry_run"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
	Enabled        bool                   `json:"enabled"`
	LastRun        *time.Time             `json:"last_run,omitempty"`
	LastSkippedAt  *time.Time             `json:"last_skipped_at,omitempty"`
	LastSkipReason string                 `json:"last_skip_reason,omitempty"`
	NextRun        *time.Time             `json:"next_run,omitempty"`
	CreatedBy      *string                `json:"created_by,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
}

func (d *DB) CreateCommand(ctx context.Context, agentID, groupID *string, cmd shared.Command, createdBy *string) (*DBCommand, error) {
	id := uuid.New().String()
	payloadJSON, _ := json.Marshal(cmd.Payload)

	_, err := d.Pool.Exec(ctx, `
		INSERT INTO commands
			(id, agent_id, group_id, type, priority, payload, dry_run, timeout_seconds, created_by, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
		id, agentID, groupID, cmd.Type, cmd.Priority, payloadJSON,
		cmd.DryRun, cmd.Timeout, createdBy)
	if err != nil {
		return nil, err
	}
	return d.GetCommand(ctx, id)
}

func (d *DB) GetCommand(ctx context.Context, id string) (*DBCommand, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT id, agent_id, group_id, type, priority, payload, dry_run,
			timeout_seconds, status, COALESCE(output,''), COALESCE(error,''),
			exit_code, duration_ms, requires_approval, approved_by, approved_at,
			COALESCE(approval_note,''), created_by, created_at, sent_at, completed_at
		FROM commands WHERE id = $1`, id)
	return scanCommand(row)
}

func (d *DB) GetPendingCommands(ctx context.Context, agentID string) ([]*DBCommand, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, agent_id, group_id, type, priority, payload, dry_run,
			timeout_seconds, status, COALESCE(output,''), COALESCE(error,''),
			exit_code, duration_ms, requires_approval, approved_by, approved_at,
			COALESCE(approval_note,''), created_by, created_at, sent_at, completed_at
		FROM commands
		WHERE agent_id = $1
		  AND status = 'pending'
		  AND (requires_approval = false OR approved_at IS NOT NULL)
		ORDER BY
			CASE priority
				WHEN 'critical' THEN 1
				WHEN 'high' THEN 2
				WHEN 'normal' THEN 3
				WHEN 'low' THEN 4
			END,
			created_at ASC`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cmds []*DBCommand
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, c)
	}

	// Mark as sent
	if len(cmds) > 0 {
		ids := make([]string, len(cmds))
		for i, c := range cmds {
			ids[i] = c.ID
		}
		_, _ = d.Pool.Exec(ctx, `
			UPDATE commands SET status = 'sent', sent_at = NOW()
			WHERE id = ANY($1::uuid[])`, ids)
	}

	return cmds, rows.Err()
}

func (d *DB) UpdateCommandResult(ctx context.Context, result *shared.CommandResult) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE commands SET
			status = $2, output = $3, error = $4, exit_code = $5,
			duration_ms = $6, completed_at = $7
		WHERE id = $1`,
		result.CommandID, result.Status, result.Output, result.Error,
		result.ExitCode, result.DurationMs, result.CompletedAt)
	return err
}

func (d *DB) CancelCommand(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE commands SET status = 'cancelled'
		WHERE id = $1 AND status IN ('pending', 'sent')`, id)
	return err
}

func (d *DB) ListCommands(ctx context.Context, agentID string, limit int) ([]*DBCommand, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT id, agent_id, group_id, type, priority, payload, dry_run,
			timeout_seconds, status, COALESCE(output,''), COALESCE(error,''),
			exit_code, duration_ms, requires_approval, approved_by, approved_at,
			COALESCE(approval_note,''), created_by, created_at, sent_at, completed_at
		FROM commands
		WHERE ($1::uuid IS NULL OR agent_id = $1)
		ORDER BY created_at DESC
		LIMIT $2`, toNullStr(agentID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cmds []*DBCommand
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, c)
	}
	return cmds, rows.Err()
}

func toNullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func scanCommand(row scannable) (*DBCommand, error) {
	var c DBCommand
	var payloadJSON []byte
	err := row.Scan(
		&c.ID, &c.AgentID, &c.GroupID, &c.Type, &c.Priority, &payloadJSON,
		&c.DryRun, &c.TimeoutSeconds, &c.Status, &c.Output, &c.Error,
		&c.ExitCode, &c.DurationMs, &c.RequiresApproval, &c.ApprovedBy, &c.ApprovedAt,
		&c.ApprovalNote, &c.CreatedBy, &c.CreatedAt,
		&c.SentAt, &c.CompletedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(payloadJSON, &c.Payload)
	return &c, nil
}

func (d *DB) SetCommandApproval(ctx context.Context, id string, approvedBy *string, note string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE commands
		SET approved_by = $2,
			approved_at = NOW(),
			approval_note = $3
		WHERE id = $1 AND requires_approval = true AND approved_at IS NULL`, id, approvedBy, note)
	return err
}

func (d *DB) RequireCommandApproval(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE commands
		SET requires_approval = true,
			approved_by = NULL,
			approved_at = NULL
		WHERE id = $1`, id)
	return err
}

func (d *DB) ListScheduledCommands(ctx context.Context, limit int) ([]*ScheduledCommand, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT sc.id, sc.name, sc.cron_expr, sc.agent_id, sc.group_id, sc.maintenance_window_id,
			COALESCE(mw.name, ''), sc.type, sc.priority, sc.payload, sc.dry_run,
			sc.timeout_seconds, sc.enabled, sc.last_run, sc.last_skipped_at,
			COALESCE(sc.last_skip_reason, ''), sc.next_run, sc.created_by, sc.created_at
		FROM scheduled_commands sc
		LEFT JOIN maintenance_windows mw ON sc.maintenance_window_id = mw.id
		ORDER BY sc.created_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*ScheduledCommand
	for rows.Next() {
		var item ScheduledCommand
		var payloadJSON []byte
		if err := rows.Scan(
			&item.ID, &item.Name, &item.CronExpr, &item.AgentID, &item.GroupID, &item.MaintenanceWindowID,
			&item.MaintenanceWindowName, &item.Type, &item.Priority, &payloadJSON, &item.DryRun, &item.TimeoutSeconds,
			&item.Enabled, &item.LastRun, &item.LastSkippedAt, &item.LastSkipReason, &item.NextRun, &item.CreatedBy, &item.CreatedAt,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(payloadJSON, &item.Payload)
		items = append(items, &item)
	}
	return items, rows.Err()
}

func (d *DB) DeleteScheduledCommand(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM scheduled_commands WHERE id = $1`, id)
	return err
}
