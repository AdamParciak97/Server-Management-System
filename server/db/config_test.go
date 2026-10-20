package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// Exercise the actual transaction SQL with synthetic SQLite data, adapting only
// bind markers. PostgreSQL locks and connection failures need integration tests.
type configSQLTransaction struct {
	tx *sql.Tx
	failCommit bool
}

func (tx configSQLTransaction) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	query = regexp.MustCompile(`\$(\d+)`).ReplaceAllString(query, `?$1`)
	r, err := tx.tx.ExecContext(ctx, query, args...)
	if err != nil { return pgconn.CommandTag{}, err }
	n, err := r.RowsAffected()
	return pgconn.NewCommandTag(fmt.Sprintf("INSERT 0 %d", n)), err
}

func (tx configSQLTransaction) Commit(context.Context) error {
	if tx.failCommit { return errors.New("synthetic commit failure") }
	return tx.tx.Commit()
}

func (tx configSQLTransaction) Rollback(context.Context) error { return tx.tx.Rollback() }

func configDatabase(t *testing.T) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "settings.db"))
	if err != nil { t.Fatal(err) }
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	_, err = database.Exec(`CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP)`)
	if err != nil { t.Fatal(err) }
	return database
}

func configValue(t *testing.T, database *sql.DB, key string) string {
	t.Helper()
	var value string
	if err := database.QueryRow(`SELECT value FROM system_config WHERE key = ?`, key).Scan(&value); err != nil { t.Fatal(err) }
	return value
}

func TestConfigSecretsPreservedEncryptedAndCleared(t *testing.T) {
	database := configDatabase(t)
	d := &DB{aesKey: []byte("01234567890123456789012345678901")}
	begin := func(ctx context.Context) (configTransaction, error) {
		tx, err := database.BeginTx(ctx, nil)
		return configSQLTransaction{tx: tx}, err
	}
	for _, key := range []string{"ldap_bind_password", "smtp_password"} {
		values := map[string]string{key: "  synthetic credential  "}
		if err := d.saveSystemConfigBatch(context.Background(), values, begin); err != nil { t.Fatal(err) }
		encrypted := configValue(t, database, key)
		plain, err := d.Decrypt(encrypted)
		if err != nil || plain != values[key] || encrypted == values[key] { t.Fatal("credential not encrypted correctly") }
		if values[key] != "  synthetic credential  " { t.Fatal("caller data changed") }
		if err := d.saveSystemConfigBatch(context.Background(), map[string]string{"smtp_host": "mail.example.test"}, begin); err != nil { t.Fatal(err) }
		if configValue(t, database, key) != encrypted { t.Fatal("unrelated save overwrote credential") }
		if err := d.saveSystemConfigBatch(context.Background(), map[string]string{key: ""}, begin); err != nil { t.Fatal(err) }
		if configValue(t, database, key) != "" { t.Fatal("credential was not removed") }
	}
}

func TestConfigPublicQueryRedactsLegacyAndEncryptedSecrets(t *testing.T) {
	database := configDatabase(t)
	d := &DB{aesKey: []byte("01234567890123456789012345678901")}
	encrypted, err := d.Encrypt("synthetic-encrypted-password")
	if err != nil { t.Fatal(err) }
	for _, secret := range []string{"synthetic-legacy-plaintext", encrypted, ""} {
		for _, key := range []string{"ldap_bind_password", "smtp_password"} {
			_, err := database.Exec(`INSERT INTO system_config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, secret)
			if err != nil { t.Fatal(err) }
		}
		rows, err := database.Query(publicSystemConfigQuery)
		if err != nil { t.Fatal(err) }
		count := 0
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil { t.Fatal(err) }
			want := "true"
			if secret == "" { want = "false" }
			if !strings.HasSuffix(key, "_configured") || value != want { t.Fatal("SQL returned a secret instead of presence metadata") }
			count++
		}
		if err := rows.Err(); err != nil { t.Fatal(err) }
		rows.Close()
		if count != 2 { t.Fatal("missing credential states") }
	}
}

func TestConfigBatchRollsBackOnFailure(t *testing.T) {
	for _, failure := range []string{"write", "commit"} {
		t.Run(failure, func(t *testing.T) {
			database := configDatabase(t)
			_, err := database.Exec(`INSERT INTO system_config(key,value) VALUES ('smtp_host','original'),('smtp_password','synthetic-original')`)
			if err != nil { t.Fatal(err) }
			if failure == "write" {
				_, err = database.Exec(`CREATE TRIGGER fail_secret BEFORE UPDATE ON system_config WHEN NEW.key='smtp_password' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`)
				if err != nil { t.Fatal(err) }
			}
			d := &DB{aesKey: []byte("01234567890123456789012345678901")}
			err = d.saveSystemConfigBatch(context.Background(), map[string]string{"smtp_host": "changed", "smtp_password": "synthetic-new"}, func(ctx context.Context) (configTransaction, error) {
				tx, err := database.BeginTx(ctx, nil)
				return configSQLTransaction{tx: tx, failCommit: failure == "commit"}, err
			})
			if err == nil { t.Fatal("failure reported as success") }
			if configValue(t, database, "smtp_host") != "original" || configValue(t, database, "smtp_password") != "synthetic-original" { t.Fatal("partial settings committed") }
		})
	}
}

func TestConfigBatchEncryptionAndBeginFailures(t *testing.T) {
	called := false
	begin := func(context.Context) (configTransaction, error) { called = true; return nil, errors.New("synthetic begin failure") }
	err := (&DB{}).saveSystemConfigBatch(context.Background(), map[string]string{"smtp_password": "synthetic"}, begin)
	if err == nil || called { t.Fatal("transaction began despite encryption failure") }
	err = (&DB{}).saveSystemConfigBatch(context.Background(), map[string]string{"smtp_host": "mail.example.test"}, begin)
	if err == nil || !called { t.Fatal("begin failure was swallowed") }
}
