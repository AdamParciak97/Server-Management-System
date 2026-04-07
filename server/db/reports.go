package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/sms/server-mgmt/shared"
)

type Report struct {
	ID             string          `json:"id"`
	AgentID        string          `json:"agent_id"`
	Timestamp      time.Time       `json:"timestamp"`
	System         json.RawMessage `json:"system_info"`
	Services       json.RawMessage `json:"services,omitempty"`
	Packages       json.RawMessage `json:"packages,omitempty"`
	SecurityAgents json.RawMessage `json:"security_agents,omitempty"`
	Processes      json.RawMessage `json:"processes,omitempty"`
	EventLogs      json.RawMessage `json:"event_logs,omitempty"`
	ScheduledTasks json.RawMessage `json:"scheduled_tasks,omitempty"`
	ReceivedAt     time.Time       `json:"received_at"`
}

func (d *DB) SaveReport(ctx context.Context, r *shared.AgentReport) (string, error) {
	id := uuid.New().String()

	sysJSON, _ := json.Marshal(r.System)
	pkgJSON, _ := json.Marshal(r.Packages)
	svcJSON, _ := json.Marshal(r.Services)
	secJSON, _ := json.Marshal(r.SecurityAgents)
	procJSON, _ := json.Marshal(r.Processes)
	eventJSON, _ := json.Marshal(r.EventLogs)
	taskJSON, _ := json.Marshal(r.ScheduledTasks)

	// Encrypt service configs (may contain sensitive info)
	cfgJSON, _ := json.Marshal(r.ServiceConfigs)
	cfgEncrypted, err := d.Encrypt(string(cfgJSON))
	if err != nil {
		return "", fmt.Errorf("encrypt configs: %w", err)
	}
	cfgEncryptedJSON, err := marshalEncryptedJSON(cfgEncrypted)
	if err != nil {
		return "", fmt.Errorf("marshal encrypted configs: %w", err)
	}

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO agent_reports
			(id, agent_id, timestamp, system_info, packages, services, service_configs, security_agents, processes, event_logs, scheduled_tasks)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		id, r.AgentID, r.Timestamp,
		sysJSON, pkgJSON, svcJSON, cfgEncryptedJSON, secJSON, procJSON, eventJSON, taskJSON)
	if err != nil {
		return "", err
	}

	// Update config snapshot and generate diff
	if err := d.updateConfigSnapshot(ctx, r.AgentID, id, r.ServiceConfigs); err != nil {
		// Non-fatal
		_ = err
	}

	return id, nil
}

func (d *DB) GetReportHistory(ctx context.Context, agentID string, limit int) ([]*Report, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT id, agent_id, timestamp, system_info, services, packages, security_agents, processes, received_at, event_logs, scheduled_tasks
		FROM agent_reports
		WHERE agent_id = $1
		ORDER BY timestamp DESC
		LIMIT $2`, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reports []*Report
	for rows.Next() {
		var rep Report
		err := rows.Scan(&rep.ID, &rep.AgentID, &rep.Timestamp,
			&rep.System, &rep.Services, &rep.Packages, &rep.SecurityAgents, &rep.Processes, &rep.ReceivedAt, &rep.EventLogs, &rep.ScheduledTasks)
		if err != nil {
			return nil, err
		}
		reports = append(reports, &rep)
	}
	return reports, rows.Err()
}

func (d *DB) GetLatestReport(ctx context.Context, agentID string) (*Report, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT id, agent_id, timestamp, system_info, services, packages, security_agents, processes, received_at, event_logs, scheduled_tasks
		FROM agent_reports
		WHERE agent_id = $1
		ORDER BY timestamp DESC
		LIMIT 1`, agentID)

	var rep Report
	err := row.Scan(&rep.ID, &rep.AgentID, &rep.Timestamp,
		&rep.System, &rep.Services, &rep.Packages, &rep.SecurityAgents, &rep.Processes, &rep.ReceivedAt, &rep.EventLogs, &rep.ScheduledTasks)
	if err != nil {
		return nil, err
	}
	return &rep, nil
}

func (d *DB) GetReport(ctx context.Context, id string) (*Report, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT id, agent_id, timestamp, system_info, services, packages, security_agents, processes, received_at, event_logs, scheduled_tasks
		FROM agent_reports
		WHERE id = $1`, id)

	var rep Report
	err := row.Scan(&rep.ID, &rep.AgentID, &rep.Timestamp,
		&rep.System, &rep.Services, &rep.Packages, &rep.SecurityAgents, &rep.Processes, &rep.ReceivedAt, &rep.EventLogs, &rep.ScheduledTasks)
	if err != nil {
		return nil, err
	}
	return &rep, nil
}

func (d *DB) GetConfigDiff(ctx context.Context, agentID, from, to string) (interface{}, error) {
	var diff json.RawMessage
	err := d.Pool.QueryRow(ctx, `
		SELECT cd.diff
		FROM config_diffs cd
		JOIN config_snapshots s1 ON cd.from_snapshot_id = s1.id
		JOIN config_snapshots s2 ON cd.to_snapshot_id = s2.id
		WHERE cd.agent_id = $1
		  AND s1.created_at >= $2::timestamptz
		  AND s2.created_at <= $3::timestamptz
		ORDER BY cd.created_at DESC
		LIMIT 1`, agentID, from, to).Scan(&diff)
	if err != nil {
		return nil, err
	}
	return diff, nil
}

func (d *DB) updateConfigSnapshot(ctx context.Context, agentID, reportID string, cfg shared.ServiceConfigs) error {
	cfgBytes, _ := json.Marshal(cfg)
	hash := fmt.Sprintf("%x", hashBytes(cfgBytes))

	// Check if same hash already exists
	var existingID string
	err := d.Pool.QueryRow(ctx, `
		SELECT id FROM config_snapshots
		WHERE agent_id = $1 AND hash = $2
		ORDER BY created_at DESC LIMIT 1`, agentID, hash).Scan(&existingID)
	if err == nil {
		// No change
		return nil
	}

	// Get previous snapshot
	var prevID string
	var prevSnapshotRaw []byte
	_ = d.Pool.QueryRow(ctx, `
		SELECT id, snapshot FROM config_snapshots
		WHERE agent_id = $1
		ORDER BY created_at DESC LIMIT 1`, agentID).Scan(&prevID, &prevSnapshotRaw)

	// Encrypt new snapshot
	encrypted, err := d.Encrypt(string(cfgBytes))
	if err != nil {
		return err
	}
	encryptedJSON, err := marshalEncryptedJSON(encrypted)
	if err != nil {
		return err
	}

	newID := uuid.New().String()
	_, err = d.Pool.Exec(ctx, `
		INSERT INTO config_snapshots (id, agent_id, report_id, snapshot, hash)
		VALUES ($1, $2, $3, $4, $5)`,
		newID, agentID, reportID, encryptedJSON, hash)
	if err != nil {
		return err
	}

	// Create diff if we have a previous snapshot
	if prevID != "" && len(prevSnapshotRaw) > 0 {
		prevEncrypted, err := unmarshalEncryptedJSON(prevSnapshotRaw)
		if err != nil {
			return nil
		}
		prevDecrypted, _ := d.Decrypt(prevEncrypted)
		diff := computeDiff(prevDecrypted, string(cfgBytes))
		diffJSON, _ := json.Marshal(diff)
		_, _ = d.Pool.Exec(ctx, `
			INSERT INTO config_diffs (id, agent_id, from_snapshot_id, to_snapshot_id, diff)
			VALUES ($1, $2, $3, $4, $5)`,
			uuid.New().String(), agentID, prevID, newID, diffJSON)
	}

	return nil
}

func hashBytes(b []byte) []byte {
	h := make([]byte, 32)
	for i, v := range b {
		h[i%32] ^= v
	}
	return h
}

type DiffEntry struct {
	Path   string      `json:"path"`
	Before interface{} `json:"before"`
	After  interface{} `json:"after"`
}

func computeDiff(before, after string) []DiffEntry {
	var b, a map[string]interface{}
	_ = json.Unmarshal([]byte(before), &b)
	_ = json.Unmarshal([]byte(after), &a)

	var diffs []DiffEntry
	for k, av := range a {
		bv, ok := b[k]
		if !ok {
			diffs = append(diffs, DiffEntry{Path: k, Before: nil, After: av})
		} else {
			bj, _ := json.Marshal(bv)
			aj, _ := json.Marshal(av)
			if string(bj) != string(aj) {
				diffs = append(diffs, DiffEntry{Path: k, Before: bv, After: av})
			}
		}
	}
	for k, bv := range b {
		if _, ok := a[k]; !ok {
			diffs = append(diffs, DiffEntry{Path: k, Before: bv, After: nil})
		}
	}
	return diffs
}

func marshalEncryptedJSON(encrypted string) (json.RawMessage, error) {
	data, err := json.Marshal(encrypted)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func unmarshalEncryptedJSON(raw []byte) (string, error) {
	var encrypted string
	if err := json.Unmarshal(raw, &encrypted); err != nil {
		return "", err
	}
	return encrypted, nil
}
