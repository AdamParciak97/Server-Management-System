package db

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrSessionInvalid = errors.New("session unavailable")

type AccountSession struct {
	ID string `json:"id"`
	UserID string `json:"-"`
	CreatedAt time.Time `json:"created_at"`
	RefreshedAt time.Time `json:"refreshed_at"`
	ExpiresAt time.Time `json:"expires_at"`
	UserAgent string `json:"user_agent"`
	Current bool `json:"current"`
}

func sessionError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) { return ErrSessionInvalid }
	return err
}

// All session mutations lock the user first. This serializes rotation, password
// changes, deactivation and revocation across different sessions of one account.
func lockSessionUser(ctx context.Context, tx pgx.Tx, userID string) error {
	var id string
	return sessionError(tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active=true FOR UPDATE`, userID).Scan(&id))
}

func (d *DB) CreateAccountSession(ctx context.Context, userID, expectedHash, sessionID, tokenHash, userAgent string, expiry time.Time) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)
	if err = lockSessionUser(ctx, tx, userID); err != nil { return err }
	// A password change between credential verification and this lock must win.
	if expectedHash != "" {
		var matches bool
		if err = tx.QueryRow(ctx, `SELECT password_hash=$2 AND auth_source<>'ldap' FROM users WHERE id=$1`, userID, expectedHash).Scan(&matches); err != nil { return err }
		if !matches { return ErrSessionInvalid }
	}
	_, err = tx.Exec(ctx, `INSERT INTO account_sessions (id,user_id,expires_at,user_agent) VALUES ($1,$2,$3,$4)`, sessionID, userID, expiry, userAgent)
	if err != nil { return err }
	_, err = tx.Exec(ctx, `INSERT INTO refresh_tokens (id,user_id,session_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)`, uuid.New().String(), userID, sessionID, tokenHash, expiry)
	if err != nil { return err }
	return tx.Commit(ctx)
}

func (d *DB) GetRefreshSession(ctx context.Context, hash string) (*AccountSession, error) {
	var item AccountSession
	err := d.Pool.QueryRow(ctx, `SELECT s.id,s.user_id,s.expires_at FROM refresh_tokens t
		JOIN account_sessions s ON s.id=t.session_id AND s.user_id=t.user_id
		JOIN users u ON u.id=s.user_id
		WHERE t.token_hash=$1 AND NOT t.revoked AND t.expires_at>NOW()
		AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.is_active`, hash).Scan(&item.ID,&item.UserID,&item.ExpiresAt)
	return &item, sessionError(err)
}

func (d *DB) RotateAccountSession(ctx context.Context, userID, sessionID, oldHash, newHash string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)
	if err = lockSessionUser(ctx, tx, userID); err != nil { return err }
	var expiry time.Time
	err = tx.QueryRow(ctx, `UPDATE account_sessions SET refreshed_at=NOW()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW() RETURNING expires_at`, sessionID,userID).Scan(&expiry)
	if err != nil { return sessionError(err) }
	tag, err := tx.Exec(ctx, `UPDATE refresh_tokens SET revoked=true
		WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND revoked=false AND expires_at>NOW()`, oldHash,sessionID,userID)
	if err != nil { return err }
	if tag.RowsAffected()!=1 { return ErrSessionInvalid }
	_, err = tx.Exec(ctx, `INSERT INTO refresh_tokens (id,user_id,session_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)`, uuid.New().String(),userID,sessionID,newHash,expiry)
	if err != nil { return err }
	return tx.Commit(ctx)
}

func (d *DB) ValidateAccountSession(ctx context.Context, userID, sessionID string) error {
	var id string
	err := d.Pool.QueryRow(ctx, `SELECT s.id FROM account_sessions s JOIN users u ON u.id=s.user_id
		WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.is_active`,sessionID,userID).Scan(&id)
	return sessionError(err)
}

func (d *DB) ListAccountSessions(ctx context.Context, userID string) ([]*AccountSession,error) {
	rows,err := d.Pool.Query(ctx, `SELECT id,created_at,refreshed_at,expires_at,user_agent FROM account_sessions
		WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 100`,userID)
	if err!=nil { return nil,err }
	defer rows.Close()
	items:=make([]*AccountSession,0)
	for rows.Next() {
		item:=&AccountSession{}
		if err=rows.Scan(&item.ID,&item.CreatedAt,&item.RefreshedAt,&item.ExpiresAt,&item.UserAgent); err!=nil { return nil,err }
		items=append(items,item)
	}
	return items,rows.Err()
}

func (d *DB) RevokeAccountSessions(ctx context.Context, userID, currentID string, others bool) (int64,error) {
	tx,err:=d.Pool.Begin(ctx)
	if err!=nil { return 0,err }
	defer tx.Rollback(ctx)
	if err=lockSessionUser(ctx,tx,userID);err!=nil { return 0,err }
	var id string
	err=tx.QueryRow(ctx, `SELECT id FROM account_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW()`,currentID,userID).Scan(&id)
	if err!=nil { return 0,sessionError(err) }
	tag,err:=tx.Exec(ctx, `UPDATE account_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()
		AND (($3=true AND id<>$2) OR ($3=false AND id=$2))`,userID,currentID,others)
	if err!=nil { return 0,err }
	_,err=tx.Exec(ctx, `UPDATE refresh_tokens SET revoked=true WHERE user_id=$1 AND session_id IN
		(SELECT id FROM account_sessions WHERE user_id=$1 AND revoked_at IS NOT NULL)`,userID)
	if err!=nil { return 0,err }
	action:="account.logout"
	if others { action="account.sessions.revoke_others" }
	_,err=tx.Exec(ctx, `INSERT INTO audit_log (user_id,username,action,result) SELECT id,username,$2,'success' FROM users WHERE id=$1`,userID,action)
	if err!=nil { return 0,err }
	if err=tx.Commit(ctx);err!=nil { return 0,err }
	return tag.RowsAffected(),nil
}

func revokeAllAccountSessions(ctx context.Context, tx pgx.Tx, userID string) error {
	if _,err:=tx.Exec(ctx, `UPDATE account_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`,userID);err!=nil { return err }
	_,err:=tx.Exec(ctx, `UPDATE refresh_tokens SET revoked=true WHERE user_id=$1 AND NOT revoked`,userID)
	return err
}
