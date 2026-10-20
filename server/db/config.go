package db

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const publicSystemConfigQuery = `SELECT
		CASE WHEN key IN ('ldap_bind_password', 'smtp_password') THEN key || '_configured' ELSE key END,
		CASE WHEN key IN ('ldap_bind_password', 'smtp_password')
			THEN CASE WHEN value <> '' THEN 'true' ELSE 'false' END ELSE value END
		FROM system_config`

// GetPublicSystemConfig never loads or decrypts a stored integration secret.
// The CASE also protects legacy plaintext values.
func (d *DB) GetPublicSystemConfig(ctx context.Context) (map[string]string, error) {
	rows, err := d.Pool.Query(ctx, publicSystemConfigQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		values[key] = value
	}
	return values, rows.Err()
}

type configTransaction interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Commit(context.Context) error
	Rollback(context.Context) error
}

func (d *DB) SetSystemConfigBatch(ctx context.Context, values map[string]string) error {
	return d.saveSystemConfigBatch(ctx, values, func(ctx context.Context) (configTransaction, error) {
		return d.Pool.Begin(ctx)
	})
}

func (d *DB) saveSystemConfigBatch(ctx context.Context, values map[string]string, begin func(context.Context) (configTransaction, error)) error {
	// Encrypt before beginning a transaction; never mutate the caller's map.
	stored := make(map[string]string, len(values))
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if sensitiveSystemConfigKeys[key] && value != "" {
			var err error
			value, err = d.Encrypt(value)
			if err != nil {
				return err
			}
		}
		stored[key] = value
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return nil
	}
	// Stable lock order for concurrent saves. Omitted secrets are never touched.
	sort.Strings(keys)
	tx, err := begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	for _, key := range keys {
		_, err := tx.Exec(ctx, `INSERT INTO system_config(key, value, updated_at)
			VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE
			SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, key, stored[key], time.Now().UTC())
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

var sensitiveSystemConfigKeys = map[string]bool{
	"ldap_bind_password": true,
	"smtp_password":      true,
}

func (d *DB) GetAllSystemConfig(ctx context.Context) (map[string]string, error) {
	rows, err := d.Pool.Query(ctx, `SELECT key, value FROM system_config`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		if sensitiveSystemConfigKeys[key] && value != "" {
			decrypted, err := d.Decrypt(value)
			if err == nil {
				value = decrypted
			}
		}
		items[key] = value
	}
	return items, rows.Err()
}

func (d *DB) GetSystemConfig(ctx context.Context, key string) (string, error) {
	var value string
	if err := d.Pool.QueryRow(ctx, `SELECT value FROM system_config WHERE key = $1`, key).Scan(&value); err != nil {
		return "", err
	}
	if sensitiveSystemConfigKeys[key] && value != "" {
		decrypted, err := d.Decrypt(value)
		if err == nil {
			value = decrypted
		}
	}
	return value, nil
}

func (d *DB) SetSystemConfig(ctx context.Context, key, value string) error {
	if sensitiveSystemConfigKeys[key] && value != "" {
		encrypted, err := d.Encrypt(value)
		if err != nil {
			return err
		}
		value = encrypted
	}
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO system_config(key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value,
			updated_at = NOW()`, key, value)
	return err
}
