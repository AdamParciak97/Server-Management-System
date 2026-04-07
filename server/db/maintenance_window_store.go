package db

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

type MaintenanceWindow struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	AgentID    *string   `json:"agent_id,omitempty"`
	AgentName  string    `json:"agent_name,omitempty"`
	GroupID    *string   `json:"group_id,omitempty"`
	GroupName  string    `json:"group_name,omitempty"`
	Timezone   string    `json:"timezone"`
	DaysOfWeek []int32   `json:"days_of_week"`
	StartTime  string    `json:"start_time"`
	EndTime    string    `json:"end_time"`
	Enabled    bool      `json:"enabled"`
	CreatedBy  *string   `json:"created_by,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

func (d *DB) ListMaintenanceWindows(ctx context.Context) ([]*MaintenanceWindow, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT mw.id, mw.name, mw.agent_id, COALESCE(a.hostname, ''),
			mw.group_id, COALESCE(g.name, ''), mw.timezone, mw.days_of_week,
			mw.start_time, mw.end_time, mw.enabled, mw.created_by, mw.created_at
		FROM maintenance_windows mw
		LEFT JOIN agents a ON mw.agent_id = a.id
		LEFT JOIN groups g ON mw.group_id = g.id
		ORDER BY mw.name, mw.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*MaintenanceWindow
	for rows.Next() {
		var item MaintenanceWindow
		if err := rows.Scan(
			&item.ID, &item.Name, &item.AgentID, &item.AgentName,
			&item.GroupID, &item.GroupName, &item.Timezone, &item.DaysOfWeek,
			&item.StartTime, &item.EndTime, &item.Enabled, &item.CreatedBy, &item.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, &item)
	}
	return items, rows.Err()
}

func (d *DB) GetMaintenanceWindow(ctx context.Context, id string) (*MaintenanceWindow, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT mw.id, mw.name, mw.agent_id, COALESCE(a.hostname, ''),
			mw.group_id, COALESCE(g.name, ''), mw.timezone, mw.days_of_week,
			mw.start_time, mw.end_time, mw.enabled, mw.created_by, mw.created_at
		FROM maintenance_windows mw
		LEFT JOIN agents a ON mw.agent_id = a.id
		LEFT JOIN groups g ON mw.group_id = g.id
		WHERE mw.id = $1`, id)

	var item MaintenanceWindow
	if err := row.Scan(
		&item.ID, &item.Name, &item.AgentID, &item.AgentName,
		&item.GroupID, &item.GroupName, &item.Timezone, &item.DaysOfWeek,
		&item.StartTime, &item.EndTime, &item.Enabled, &item.CreatedBy, &item.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &item, nil
}

func (d *DB) CreateMaintenanceWindow(ctx context.Context, item *MaintenanceWindow) (*MaintenanceWindow, error) {
	id := uuid.New().String()
	if strings.TrimSpace(item.Timezone) == "" {
		item.Timezone = "UTC"
	}
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO maintenance_windows
			(id, name, agent_id, group_id, timezone, days_of_week, start_time, end_time, enabled, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		id, item.Name, item.AgentID, item.GroupID, item.Timezone, item.DaysOfWeek,
		item.StartTime, item.EndTime, item.Enabled, item.CreatedBy)
	if err != nil {
		return nil, err
	}
	return d.GetMaintenanceWindow(ctx, id)
}

func (d *DB) DeleteMaintenanceWindow(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM maintenance_windows WHERE id = $1`, id)
	return err
}

func (d *DB) UpdateScheduledCommandRun(ctx context.Context, id string, at time.Time) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE scheduled_commands
		SET last_run = $2,
			last_skipped_at = NULL,
			last_skip_reason = ''
		WHERE id = $1`, id, at)
	return err
}

func (d *DB) UpdateScheduledCommandSkip(ctx context.Context, id, reason string, at time.Time) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE scheduled_commands
		SET last_skipped_at = $2,
			last_skip_reason = $3
		WHERE id = $1`, id, at, reason)
	return err
}

func (d *DB) MaintenanceWindowAllows(ctx context.Context, item *MaintenanceWindow, at time.Time) bool {
	if item == nil || !item.Enabled {
		return true
	}
	loc, err := time.LoadLocation(strings.TrimSpace(item.Timezone))
	if err != nil {
		loc = time.UTC
	}
	local := at.In(loc)
	startMinutes, okStart := parseClockMinutes(item.StartTime)
	endMinutes, okEnd := parseClockMinutes(item.EndTime)
	if !okStart || !okEnd {
		return false
	}
	day := int32(local.Weekday())
	currentMinutes := local.Hour()*60 + local.Minute()
	if startMinutes == endMinutes {
		return containsDay(item.DaysOfWeek, day)
	}
	if startMinutes < endMinutes {
		if !containsDay(item.DaysOfWeek, day) {
			return false
		}
		return currentMinutes >= startMinutes && currentMinutes < endMinutes
	}
	if currentMinutes >= startMinutes {
		return containsDay(item.DaysOfWeek, day)
	}
	prevDay := int32((int(day) + 6) % 7)
	return containsDay(item.DaysOfWeek, prevDay)
}

func containsDay(days []int32, target int32) bool {
	for _, day := range days {
		if day == target {
			return true
		}
	}
	return false
}

func parseClockMinutes(value string) (int, bool) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return parsed.Hour()*60 + parsed.Minute(), true
}
