package db

import (
	"context"
	"time"
)

type AgentBaseline struct {
	AgentID   string     `json:"agent_id"`
	ReportID  string     `json:"report_id"`
	CreatedBy *string    `json:"created_by,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	Report    *Report    `json:"report,omitempty"`
}

func (d *DB) SetAgentBaseline(ctx context.Context, agentID, reportID string, createdBy *string) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO agent_baselines (agent_id, report_id, created_by, created_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (agent_id) DO UPDATE
		SET report_id = EXCLUDED.report_id,
			created_by = EXCLUDED.created_by,
			created_at = NOW()`,
		agentID, reportID, createdBy)
	return err
}

func (d *DB) GetAgentBaseline(ctx context.Context, agentID string) (*AgentBaseline, error) {
	var item AgentBaseline
	if err := d.Pool.QueryRow(ctx, `
		SELECT agent_id, report_id, created_by, created_at
		FROM agent_baselines
		WHERE agent_id = $1`, agentID).Scan(&item.AgentID, &item.ReportID, &item.CreatedBy, &item.CreatedAt); err != nil {
		return nil, err
	}
	report, err := d.GetReport(ctx, item.ReportID)
	if err != nil {
		return nil, err
	}
	item.Report = report
	return &item, nil
}

func (d *DB) CountAgentBaselines(ctx context.Context) (int, error) {
	var count int
	if err := d.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM agent_baselines`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
