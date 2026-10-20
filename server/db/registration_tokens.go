package db

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrRegistrationTokenUnavailable = errors.New("registration token unavailable")

type RegToken struct {
	ID string `json:"id"`
	Token string `json:"token,omitempty"`
	CreatedBy *string `json:"created_by,omitempty"`
	Used bool `json:"used"`
	UsedAt *time.Time `json:"used_at,omitempty"`
	UsedBy *string `json:"used_by,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	RevokedBy *string `json:"revoked_by,omitempty"`
	Note string `json:"note,omitempty"`
}

type TokenActor struct { UserID, Username, IP string }

type tokenTransaction interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Commit(context.Context) error
	Rollback(context.Context) error
}
type tokenBegin func(context.Context) (tokenTransaction, error)

func (d *DB) beginTokenTransaction(ctx context.Context) (tokenTransaction, error) {
	return d.Pool.Begin(ctx)
}

func tokenAudit(ctx context.Context, tx tokenTransaction, actor TokenActor, action, id string) error {
	_, err := tx.Exec(ctx, `INSERT INTO audit_log
		(id, user_id, username, ip, action, resource, resource_id, result)
		VALUES ($1, $2, $3, $4, $5, 'registration_token', $6, 'success')`,
		uuid.New().String(), actor.UserID, actor.Username, actor.IP, action, id)
	return err
}

func (d *DB) CreateRegistrationToken(ctx context.Context, actor TokenActor, expiresAt *time.Time, note string) (*RegToken, error) {
	return createRegistrationToken(ctx, d.beginTokenTransaction, actor, expiresAt, note)
}

func createRegistrationToken(ctx context.Context, begin tokenBegin, actor TokenActor, expiresAt *time.Time, note string) (*RegToken, error) {
	t := &RegToken{ID: uuid.New().String(), Token: uuid.New().String(), CreatedBy: &actor.UserID,
		ExpiresAt: expiresAt, Note: note, CreatedAt: time.Now().UTC()}
	tx, err := begin(ctx)
	if err != nil { return nil, err }
	defer tx.Rollback(context.WithoutCancel(ctx))
	_, err = tx.Exec(ctx, `INSERT INTO registration_tokens (id, token, created_by, expires_at, note, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, t.ID, t.Token, actor.UserID, expiresAt, note, t.CreatedAt)
	if err != nil { return nil, err }
	if err = tokenAudit(ctx, tx, actor, "token.create", t.ID); err != nil { return nil, err }
	if err = tx.Commit(ctx); err != nil { return nil, err }
	return t, nil
}

// The secret is deliberately absent from the query, including legacy credentials.
const listRegistrationTokensQuery = `SELECT id, created_by, used, used_at, used_by,
	expires_at, created_at, revoked_at, revoked_by, COALESCE(note,'')
	FROM registration_tokens ORDER BY created_at DESC, id DESC`

func (d *DB) ListRegistrationTokens(ctx context.Context) ([]*RegToken, error) {
	rows, err := d.Pool.Query(ctx, listRegistrationTokensQuery)
	if err != nil { return nil, err }
	defer rows.Close()
	tokens := []*RegToken{}
	for rows.Next() {
		var t RegToken
		if err := rows.Scan(&t.ID, &t.CreatedBy, &t.Used, &t.UsedAt, &t.UsedBy,
			&t.ExpiresAt, &t.CreatedAt, &t.RevokedAt, &t.RevokedBy, &t.Note); err != nil { return nil, err }
		tokens = append(tokens, &t)
	}
	return tokens, rows.Err()
}

func (d *DB) RevokeRegistrationToken(ctx context.Context, id string, actor TokenActor) error {
	return revokeRegistrationToken(ctx, d.beginTokenTransaction, id, actor)
}

func revokeRegistrationToken(ctx context.Context, begin tokenBegin, id string, actor TokenActor) error {
	tx, err := begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(context.WithoutCancel(ctx))
	tag, err := tx.Exec(ctx, `UPDATE registration_tokens SET revoked_at = $2, revoked_by = $3
		WHERE id = $1 AND used = false AND revoked_at IS NULL`, id, time.Now().UTC(), actor.UserID)
	if err != nil { return err }
	if tag.RowsAffected() != 1 { return ErrRegistrationTokenUnavailable }
	if err = tokenAudit(ctx, tx, actor, "token.revoke", id); err != nil { return err }
	return tx.Commit(ctx)
}

func (d *DB) RegisterAgentWithToken(ctx context.Context, token, hostname, certFP, version string) (string, error) {
	return registerAgentWithToken(ctx, d.beginTokenTransaction, token, hostname, certFP, version)
}

func registerAgentWithToken(ctx context.Context, begin tokenBegin, token, hostname, certFP, version string) (string, error) {
	id := uuid.New().String()
	tx, err := begin(ctx)
	if err != nil { return "", err }
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Both registration and revocation lock the same row. Recheck eligibility in
	// the UPDATE, never rely on an earlier SELECT. Insert failure rolls back use.
	tag, err := tx.Exec(ctx, `UPDATE registration_tokens SET used = true, used_at = $2, used_by = $3
		WHERE token = $1 AND used = false AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > $2)`, token, time.Now().UTC(), id)
	if err != nil { return "", err }
	if tag.RowsAffected() != 1 { return "", ErrRegistrationTokenUnavailable }
	_, err = tx.Exec(ctx, `INSERT INTO agents (id, hostname, agent_version, cert_fingerprint, status)
		VALUES ($1, $2, $3, $4, 'online')`, id, hostname, version, certFP)
	if err != nil { return "", err }
	if err = tx.Commit(ctx); err != nil { return "", err }
	return id, nil
}
