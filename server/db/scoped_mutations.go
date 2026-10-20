package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

var ErrScopedResourceMissing = errors.New("resource not found in current scope")
var ErrGroupInUse = errors.New("group is still referenced")

// Scope is part of the write, not a best-effort preflight list (which may fail
// or be truncated). nil means global; an empty non-nil slice grants nothing.
func (d *DB) AcknowledgeAlertScoped(ctx context.Context, id, userID string, scopes []string) error {
	tag, err := d.Pool.Exec(ctx, `UPDATE alerts SET acknowledged=true, acknowledged_by=$2, acknowledged_at=NOW()
		WHERE id=$1 AND ($3::uuid[] IS NULL OR EXISTS
		(SELECT 1 FROM agents a WHERE a.id=alerts.agent_id AND a.group_id=ANY($3::uuid[])))`, id, userID, scopes)
	if err != nil { return err }
	if tag.RowsAffected() == 0 { return ErrScopedResourceMissing }
	return nil
}

func (d *DB) DeleteCompliancePolicyScoped(ctx context.Context, id string, scopes []string) error {
	tag, err := d.Pool.Exec(ctx, `DELETE FROM compliance_policies WHERE id=$1
		AND ($2::uuid[] IS NULL OR group_id=ANY($2::uuid[]))`, id, scopes)
	if err != nil { return err }
	if tag.RowsAffected() == 0 { return ErrScopedResourceMissing }
	return nil
}

func (d *DB) DeleteComplianceExceptionScoped(ctx context.Context, id string, scopes []string) error {
	tag, err := d.Pool.Exec(ctx, `DELETE FROM compliance_exceptions WHERE id=$1
		AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM agents a
		WHERE a.id=compliance_exceptions.agent_id AND a.group_id=ANY($2::uuid[])))`, id, scopes)
	if err != nil { return err }
	if tag.RowsAffected() == 0 { return ErrScopedResourceMissing }
	return nil
}

func groupWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" { return ErrGroupInUse }
	return err
}
