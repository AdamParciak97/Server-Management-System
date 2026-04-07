package buffer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"github.com/sms/server-mgmt/shared"
)

// Buffer stores agent reports locally when the server is unreachable.
type Buffer struct {
	db *sql.DB
}

func New(path string) (*Buffer, error) {
	db, err := sql.Open("sqlite", path+"?_journal=WAL&_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	b := &Buffer{db: db}
	if err := b.init(); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Buffer) Close() error {
	return b.db.Close()
}

func (b *Buffer) init() error {
	_, err := b.db.Exec(`
		CREATE TABLE IF NOT EXISTS buffered_reports (
			id       INTEGER PRIMARY KEY AUTOINCREMENT,
			payload  TEXT NOT NULL,
			created  DATETIME NOT NULL DEFAULT (datetime('now')),
			attempts INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS agent_state (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`)
	return err
}

// Save stores a report for later transmission.
func (b *Buffer) Save(ctx context.Context, report *shared.AgentReport) error {
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO buffered_reports (payload) VALUES (?)`, string(data))
	return err
}

// Pending returns buffered reports ordered by creation time.
func (b *Buffer) Pending(ctx context.Context, limit int) ([]*shared.AgentReport, []int64, error) {
	rows, err := b.db.QueryContext(ctx, `
		SELECT id, payload FROM buffered_reports
		ORDER BY created ASC LIMIT ?`, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var reports []*shared.AgentReport
	var ids []int64
	for rows.Next() {
		var id int64
		var payload string
		if err := rows.Scan(&id, &payload); err != nil {
			continue
		}
		var r shared.AgentReport
		if err := json.Unmarshal([]byte(payload), &r); err != nil {
			continue
		}
		reports = append(reports, &r)
		ids = append(ids, id)
	}
	return reports, ids, rows.Err()
}

// Delete removes a successfully sent report from the buffer.
func (b *Buffer) Delete(ctx context.Context, id int64) error {
	_, err := b.db.ExecContext(ctx, `DELETE FROM buffered_reports WHERE id = ?`, id)
	return err
}

// IncrAttempts increments the attempt count for a report.
func (b *Buffer) IncrAttempts(ctx context.Context, id int64) error {
	_, err := b.db.ExecContext(ctx, `UPDATE buffered_reports SET attempts = attempts + 1 WHERE id = ?`, id)
	return err
}

// Count returns the number of pending reports.
func (b *Buffer) Count(ctx context.Context) (int, error) {
	var count int
	err := b.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM buffered_reports`).Scan(&count)
	return count, err
}

// SetState saves a key-value state (e.g. agent ID).
func (b *Buffer) SetState(ctx context.Context, key, value string) error {
	_, err := b.db.ExecContext(ctx, `
		INSERT INTO agent_state(key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// GetState retrieves a state value.
func (b *Buffer) GetState(ctx context.Context, key string) (string, error) {
	var value string
	err := b.db.QueryRowContext(ctx, `SELECT value FROM agent_state WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// PruneOld removes reports older than maxAge to prevent unbounded growth.
func (b *Buffer) PruneOld(ctx context.Context, maxAge time.Duration) (int64, error) {
	cutoff := time.Now().Add(-maxAge).UTC().Format("2006-01-02 15:04:05")
	res, err := b.db.ExecContext(ctx, `DELETE FROM buffered_reports WHERE created < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
