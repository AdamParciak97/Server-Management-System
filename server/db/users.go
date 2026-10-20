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
			auth_source = 'ldap'
		WHERE users.auth_source = 'ldap' AND users.is_active = true
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
	tx, err := d.Pool.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)
	if err = lockSessionUser(ctx, tx, id); err != nil { return err }
	if _, err = tx.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, id); err != nil { return err }
	if err = revokeAllAccountSessions(ctx, tx, id); err != nil { return err }
	return tx.Commit(ctx)
}

func (d *DB) GetUserPasswordHash(ctx context.Context, id string) (string, error) {
	var hash string
	err := d.Pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1 AND is_active = true`, id).Scan(&hash)
	return hash, err
}

func (d *DB) UpdateUserPassword(ctx context.Context, id, expectedHash, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}
	tx, err := d.Pool.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)
	if err = lockSessionUser(ctx, tx, id); err != nil { return err }
	tag, err := tx.Exec(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3 AND auth_source<>'ldap'`, id, string(hash), expectedHash)
	if err != nil { return err }
	if tag.RowsAffected()!=1 { return ErrSessionInvalid }
	if err = revokeAllAccountSessions(ctx, tx, id); err != nil { return err }
	if _, err = tx.Exec(ctx, `INSERT INTO audit_log (user_id,username,action,result) SELECT id,username,'account.password.change','success' FROM users WHERE id=$1`, id); err != nil { return err }
	return tx.Commit(ctx)
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
