package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type CompliancePolicy struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	GroupID       *string    `json:"group_id,omitempty"`
	GroupName     string     `json:"group_name,omitempty"`
	PolicyType    string     `json:"policy_type"`
	Subject       string     `json:"subject"`
	ExpectedValue string     `json:"expected_value,omitempty"`
	Severity      string     `json:"severity"`
	Enabled       bool       `json:"enabled"`
	CreatedBy     *string    `json:"created_by,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}

func (d *DB) ListCompliancePolicies(ctx context.Context) ([]*CompliancePolicy, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT p.id, p.name, p.group_id, COALESCE(g.name,''), p.policy_type, p.subject,
			COALESCE(p.expected_value,''), p.severity, p.enabled, p.created_by, p.created_at
		FROM compliance_policies p
		LEFT JOIN groups g ON p.group_id = g.id
		ORDER BY p.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*CompliancePolicy
	for rows.Next() {
		var item CompliancePolicy
		if err := rows.Scan(
			&item.ID, &item.Name, &item.GroupID, &item.GroupName, &item.PolicyType,
			&item.Subject, &item.ExpectedValue, &item.Severity, &item.Enabled, &item.CreatedBy, &item.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, &item)
	}
	return items, rows.Err()
}

func (d *DB) CreateCompliancePolicy(ctx context.Context, policy CompliancePolicy) (*CompliancePolicy, error) {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO compliance_policies
			(id, name, group_id, policy_type, subject, expected_value, severity, enabled, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		id, policy.Name, policy.GroupID, policy.PolicyType, policy.Subject,
		policy.ExpectedValue, policy.Severity, policy.Enabled, policy.CreatedBy)
	if err != nil {
		return nil, err
	}

	row := d.Pool.QueryRow(ctx, `
		SELECT p.id, p.name, p.group_id, COALESCE(g.name,''), p.policy_type, p.subject,
			COALESCE(p.expected_value,''), p.severity, p.enabled, p.created_by, p.created_at
		FROM compliance_policies p
		LEFT JOIN groups g ON p.group_id = g.id
		WHERE p.id = $1`, id)

	var item CompliancePolicy
	if err := row.Scan(
		&item.ID, &item.Name, &item.GroupID, &item.GroupName, &item.PolicyType,
		&item.Subject, &item.ExpectedValue, &item.Severity, &item.Enabled, &item.CreatedBy, &item.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &item, nil
}

func (d *DB) DeleteCompliancePolicy(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM compliance_policies WHERE id = $1`, id)
	return err
}
