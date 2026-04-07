package db

import (
	"context"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	Email        string     `json:"email"`
	Role         string     `json:"role"`
	AuthSource   string     `json:"auth_source"`
	IsActive     bool       `json:"is_active"`
	CreatedAt    time.Time  `json:"created_at"`
	LastLogin    *time.Time `json:"last_login,omitempty"`
}

func (d *DB) GetUserByUsername(ctx context.Context, username string) (*User, string, error) {
	var u User
	var hash string
	err := d.Pool.QueryRow(ctx, `
		SELECT id, username, email, role, auth_source, is_active, created_at, last_login, password_hash
		FROM users WHERE username = $1 AND is_active = true`, username).
		Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.AuthSource, &u.IsActive, &u.CreatedAt, &u.LastLogin, &hash)
	if err != nil {
		return nil, "", err
	}
	return &u, hash, nil
}

func (d *DB) GetUserByID(ctx context.Context, id string) (*User, error) {
	var u User
	err := d.Pool.QueryRow(ctx, `
		SELECT id, username, email, role, auth_source, is_active, created_at, last_login
		FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.AuthSource, &u.IsActive, &u.CreatedAt, &u.LastLogin)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (d *DB) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, username, email, role, auth_source, is_active, created_at, last_login
		FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		var u User
		err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.AuthSource, &u.IsActive, &u.CreatedAt, &u.LastLogin)
		if err != nil {
			return nil, err
		}
		users = append(users, &u)
	}
	return users, rows.Err()
}

func (d *DB) CreateUser(ctx context.Context, username, email, password, role string) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return nil, err
	}
	id := uuid.New().String()
	_, err = d.Pool.Exec(ctx, `
		INSERT INTO users (id, username, email, password_hash, role)
		VALUES ($1, $2, $3, $4, $5)`, id, username, email, string(hash), role)
	if err != nil {
		return nil, err
	}
	return d.GetUserByID(ctx, id)
}

func (d *DB) CreateOrUpdateLDAPUser(ctx context.Context, username, email, role string) (*User, error) {
	var id string
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO users (id, username, email, password_hash, role, auth_source, is_active)
		VALUES ($1, $2, $3, $4, $5, 'ldap', true)
		ON CONFLICT (username) DO UPDATE
		SET email = EXCLUDED.email,
			role = EXCLUDED.role,
			auth_source = 'ldap',
			is_active = true
		RETURNING id`,
		uuid.New().String(), username, email, "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCNNEMwdGTMaKTFCeHxOVA2", role).Scan(&id)
	if err != nil {
		return nil, err
	}
	return d.GetUserByID(ctx, id)
}

func (d *DB) UpdateUserLastLogin(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `UPDATE users SET last_login = NOW() WHERE id = $1`, id)
	return err
}

func (d *DB) DeleteUser(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `UPDATE users SET is_active = false WHERE id = $1`, id)
	return err
}

func (d *DB) GetUserPasswordHash(ctx context.Context, id string) (string, error) {
	var hash string
	err := d.Pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1 AND is_active = true`, id).Scan(&hash)
	return hash, err
}

func (d *DB) UpdateUserPassword(ctx context.Context, id, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}
	_, err = d.Pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, id, string(hash))
	return err
}

func (d *DB) VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func (d *DB) ListUserPermissions(ctx context.Context, userID string) ([]string, error) {
	rows, err := d.Pool.Query(ctx, `SELECT permission FROM user_permissions WHERE user_id = $1 ORDER BY permission`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []string
	for rows.Next() {
		var permission string
		if err := rows.Scan(&permission); err != nil {
			return nil, err
		}
		items = append(items, permission)
	}
	return items, rows.Err()
}

func (d *DB) SetUserPermissions(ctx context.Context, userID string, permissions []string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM user_permissions WHERE user_id = $1`, userID); err != nil {
		return err
	}
	for _, permission := range permissions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_permissions (user_id, permission)
			VALUES ($1, $2)`, userID, permission); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ─── Refresh tokens ───────────────────────────────────────────────────────────

func (d *DB) SaveRefreshToken(ctx context.Context, userID, tokenHash string, expiresAt time.Time) error {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
		VALUES ($1, $2, $3, $4)`, id, userID, tokenHash, expiresAt)
	return err
}

func (d *DB) ValidateRefreshToken(ctx context.Context, tokenHash string) (string, error) {
	var userID string
	err := d.Pool.QueryRow(ctx, `
		SELECT user_id FROM refresh_tokens
		WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()`,
		tokenHash).Scan(&userID)
	return userID, err
}

func (d *DB) RevokeRefreshToken(ctx context.Context, tokenHash string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`, tokenHash)
	return err
}

// ─── Registration tokens ──────────────────────────────────────────────────────

type RegToken struct {
	ID        string     `json:"id"`
	Token     string     `json:"token"`
	CreatedBy *string    `json:"created_by,omitempty"`
	Used      bool       `json:"used"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	Note      string     `json:"note,omitempty"`
}

func (d *DB) CreateRegistrationToken(ctx context.Context, userID *string, expiresAt *time.Time, note string) (*RegToken, error) {
	id := uuid.New().String()
	token := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO registration_tokens (id, token, created_by, expires_at, note)
		VALUES ($1, $2, $3, $4, $5)`, id, token, userID, expiresAt, note)
	if err != nil {
		return nil, err
	}
	return &RegToken{ID: id, Token: token, CreatedBy: func() *string { s := id; return &s }(), Note: note}, nil
}

func (d *DB) ListRegistrationTokens(ctx context.Context) ([]*RegToken, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, token, created_by, used, used_at, expires_at, created_at, COALESCE(note,'')
		FROM registration_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tokens []*RegToken
	for rows.Next() {
		var t RegToken
		err := rows.Scan(&t.ID, &t.Token, &t.CreatedBy, &t.Used, &t.UsedAt, &t.ExpiresAt, &t.CreatedAt, &t.Note)
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, &t)
	}
	return tokens, rows.Err()
}
