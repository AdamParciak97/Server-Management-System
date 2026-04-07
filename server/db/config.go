package db

import (
	"context"
)

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
