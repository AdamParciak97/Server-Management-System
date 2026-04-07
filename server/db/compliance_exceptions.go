package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type ComplianceException struct {
	ID        string     `json:"id"`
	PolicyID   string     `json:"policy_id"`
	AgentID    string     `json:"agent_id"`
	Reason     string     `json:"reason"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	CreatedBy  *string    `json:"created_by,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (d *DB) ListComplianceExceptions(ctx context.Context) ([]*ComplianceException, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, policy_id, agent_id, reason, expires_at, created_by, created_at
		FROM compliance_exceptions
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*ComplianceException
	for rows.Next() {
		var item ComplianceException
		if err := rows.Scan(&item.ID, &item.PolicyID, &item.AgentID, &item.Reason, &item.ExpiresAt, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, &item)
	}
	return items, rows.Err()
}

func (d *DB) CreateComplianceException(ctx context.Context, policyID, agentID, reason string, expiresAt *time.Time, createdBy *string) (*ComplianceException, error) {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO compliance_exceptions (id, policy_id, agent_id, reason, expires_at, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		id, policyID, agentID, reason, expiresAt, createdBy)
	if err != nil {
		return nil, err
	}

	row := d.Pool.QueryRow(ctx, `
		SELECT id, policy_id, agent_id, reason, expires_at, created_by, created_at
		FROM compliance_exceptions
		WHERE id = $1`, id)

	var item ComplianceException
	if err := row.Scan(&item.ID, &item.PolicyID, &item.AgentID, &item.Reason, &item.ExpiresAt, &item.CreatedBy, &item.CreatedAt); err != nil {
		return nil, err
	}
	return &item, nil
}

func (d *DB) DeleteComplianceException(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM compliance_exceptions WHERE id = $1`, id)
	return err
}
