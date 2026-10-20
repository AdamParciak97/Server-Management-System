package buffer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/sms/server-mgmt/shared"
)

func newTestBuffer(t *testing.T) *Buffer {
	t.Helper()
	b, err := New(filepath.Join(t.TempDir(), "buffer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := b.Close(); err != nil {
			t.Error(err)
		}
	})
	return b
}

func TestPendingRejectsCorruptBatchWithoutDeletingReports(t *testing.T) {
	for _, payload := range []string{`{"agent_id":`, `{"agent_id":42}`} {
		for _, corruptFirst := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/first=%t", payload, corruptFirst), func(t *testing.T) {
				b := newTestBuffer(t)
				ctx := context.Background()
				payloads := []string{`{"agent_id":"test-agent"}`, payload}
				if corruptFirst {
					payloads[0], payloads[1] = payloads[1], payloads[0]
				}
				var corruptID int64
				for i, value := range payloads {
					// Explicit timestamps make the batch order independent of SQLite ties.
					res, err := b.db.ExecContext(ctx,
						`INSERT INTO buffered_reports (payload, created) VALUES (?, ?)`,
						value, fmt.Sprintf("2026-01-01 00:00:0%d", i))
					if err != nil {
						t.Fatal(err)
					}
					if value == payload {
						corruptID, err = res.LastInsertId()
						if err != nil {
							t.Fatal(err)
						}
					}
				}

				reports, ids, err := b.Pending(ctx, 10)
				if err == nil {
					t.Fatal("Pending silently accepted a corrupt batch")
				}
				if !strings.Contains(err.Error(), fmt.Sprintf("decode buffered report %d:", corruptID)) {
					t.Errorf("error does not identify the corrupt row: %v", err)
				}
				var syntaxErr *json.SyntaxError
				var typeErr *json.UnmarshalTypeError
				if !errors.As(err, &syntaxErr) && !errors.As(err, &typeErr) {
					t.Errorf("error does not wrap the JSON failure: %v", err)
				}
				if reports != nil || ids != nil {
					t.Errorf("Pending returned a partial batch: reports=%v ids=%v", reports, ids)
				}
				if count, err := b.Count(ctx); err != nil || count != 2 {
					t.Errorf("stored reports changed: count=%d error=%v", count, err)
				}
			})
		}
	}
}

func TestPendingReturnsSavedReportAndID(t *testing.T) {
	b := newTestBuffer(t)
	ctx := context.Background()
	want := &shared.AgentReport{AgentID: "test-agent"}
	if err := b.Save(ctx, want); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{0, 1} {
		reports, ids, err := b.Pending(ctx, limit)
		if err != nil {
			t.Fatal(err)
		}
		if len(reports) != limit || len(ids) != limit {
			t.Fatalf("limit=%d: reports=%d ids=%d", limit, len(reports), len(ids))
		}
		if limit == 1 {
			if !reflect.DeepEqual(reports[0], want) {
				t.Errorf("report=%+v, want %+v", reports[0], want)
			}
			var payload string
			if err := b.db.QueryRowContext(ctx,
				`SELECT payload FROM buffered_reports WHERE id = ?`, ids[0]).Scan(&payload); err != nil {
				t.Fatalf("returned ID does not identify a stored report: %v", err)
			}
		}
	}
}

func TestPendingReturnsCanceledContext(t *testing.T) {
	b := newTestBuffer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reports, ids, err := b.Pending(ctx, 10)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v, want context.Canceled", err)
	}
	if reports != nil || ids != nil {
		t.Errorf("canceled read returned a batch: reports=%v ids=%v", reports, ids)
	}
}
