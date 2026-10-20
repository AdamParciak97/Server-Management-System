package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sms/server-mgmt/shared"
	_ "modernc.org/sqlite"
)

const resultAgentA = "00000000-0000-0000-0000-000000000001"
const resultAgentB = "00000000-0000-0000-0000-000000000002"
const resultCommand = "00000000-0000-0000-0000-000000000003"

// Execute the production INSERT/UPDATE against an isolated database. Only
// numbered bind-marker syntax is adapted; predicates and writes are unchanged.
// This does not replace PostgreSQL-specific concurrency/integration checks.
type resultSQLExecutor struct{ db *sql.DB }

func (e resultSQLExecutor) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	query = regexp.MustCompile(`\$(\d+)`).ReplaceAllString(query, `?$1`)
	r, err := e.db.ExecContext(ctx, query, args...)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	n, err := r.RowsAffected()
	return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", n)), err
}

func resultDatabase(t *testing.T) resultSQLExecutor {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "commands.db"))
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	_, err = database.Exec(`CREATE TABLE commands (
		id TEXT PRIMARY KEY, agent_id TEXT, group_id TEXT, type TEXT, priority TEXT,
		payload BLOB, dry_run BOOLEAN, timeout_seconds INTEGER, created_by TEXT,
		status TEXT, output TEXT, error TEXT, exit_code INTEGER, duration_ms INTEGER,
		completed_at TIMESTAMP, requires_approval BOOLEAN DEFAULT false, approved_at TIMESTAMP)`)
	if err != nil {
		t.Fatal(err)
	}
	return resultSQLExecutor{database}
}

func seedResultCommand(t *testing.T, e resultSQLExecutor, status string, approval bool, approvedAt any) {
	t.Helper()
	_, err := e.db.Exec(`INSERT INTO commands (id, agent_id, status, output, error, exit_code,
		duration_ms, requires_approval, approved_at) VALUES (?, ?, ?, 'original', 'original-error', 7, 8, ?, ?)`,
		resultCommand, resultAgentB, status, approval, approvedAt)
	if err != nil {
		t.Fatal(err)
	}
}

func validResult() *shared.CommandResult {
	return &shared.CommandResult{CommandID: resultCommand, AgentID: resultAgentB,
		Status: "success", Output: "synthetic output", DurationMs: 10, CompletedAt: time.Now().UTC()}
}

func TestCommandResultOwnershipAndState(t *testing.T) {
	for _, tc := range []struct {
		name, agent, before, after string
		approval                  bool
		approvedAt                any
		accepted                  bool
	}{
		{"other_agent", resultAgentA, "sent", "success", false, nil, false},
		{"sent_success", resultAgentB, "sent", "success", false, nil, true},
		{"running_error", resultAgentB, "running", "error", false, nil, true},
		{"sent_timeout", resultAgentB, "sent", "timeout", false, nil, true},
		{"pending", resultAgentB, "pending", "success", false, nil, false},
		{"cancelled", resultAgentB, "cancelled", "success", false, nil, false},
		{"completed", resultAgentB, "success", "error", false, nil, false},
		{"failed", resultAgentB, "error", "success", false, nil, false},
		{"timed_out", resultAgentB, "timeout", "success", false, nil, false},
		{"unapproved_script", resultAgentB, "sent", "success", true, nil, false},
		{"approved_script", resultAgentB, "sent", "success", true, time.Now(), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := resultDatabase(t)
			seedResultCommand(t, e, tc.before, tc.approval, tc.approvedAt)
			r := validResult()
			r.Status = tc.after
			err := updateCommandResult(context.Background(), e, tc.agent, r)
			if tc.accepted && err != nil || !tc.accepted && !errors.Is(err, ErrCommandResultConflict) {
				t.Fatalf("accepted=%v, error=%v", tc.accepted, err)
			}
			var status, output, message string
			var exitCode, duration int
			var completed any
			if err := e.db.QueryRow(`SELECT status, output, error, exit_code, duration_ms, completed_at FROM commands WHERE id = ?`, resultCommand).
				Scan(&status, &output, &message, &exitCode, &duration, &completed); err != nil {
				t.Fatal(err)
			}
			if !tc.accepted && (status != tc.before || output != "original" || message != "original-error" || exitCode != 7 || duration != 8 || completed != nil) {
				t.Fatalf("rejected result mutated command: %s %s %s %d %d %v", status, output, message, exitCode, duration, completed)
			}
			if tc.accepted && (status != tc.after || output != r.Output || message != r.Error || exitCode != r.ExitCode || duration != 10 || completed == nil) {
				t.Fatal("accepted result was not fully persisted")
			}
		})
	}
}

func TestCommandResultValidationAndMissingCommand(t *testing.T) {
	for _, status := range []string{"", "pending", "sent", "running", "cancelled", "SUCCESS", "success';--"} {
		r := validResult()
		r.Status = status
		if err := updateCommandResult(context.Background(), nil, resultAgentB, r); !errors.Is(err, ErrInvalidCommandResult) {
			t.Fatalf("status %q: %v", status, err)
		}
	}
	for _, mutate := range []func(*shared.CommandResult){
		func(r *shared.CommandResult) { r.CommandID = "invalid" },
		func(r *shared.CommandResult) { r.DurationMs = -1 },
		func(r *shared.CommandResult) { r.CompletedAt = time.Time{} },
	} {
		r := validResult()
		mutate(r)
		if err := updateCommandResult(context.Background(), nil, resultAgentB, r); !errors.Is(err, ErrInvalidCommandResult) {
			t.Fatalf("validation: %v", err)
		}
	}
	if err := updateCommandResult(context.Background(), nil, "", validResult()); !errors.Is(err, ErrInvalidCommandResult) {
		t.Fatalf("missing identity: %v", err)
	}
	e := resultDatabase(t)
	if err := updateCommandResult(context.Background(), e, resultAgentB, validResult()); !errors.Is(err, ErrCommandResultConflict) {
		t.Fatalf("missing command: %v", err)
	}
	e.db.Close()
	if err := updateCommandResult(context.Background(), e, resultAgentB, validResult()); err == nil || errors.Is(err, ErrCommandResultConflict) {
		t.Fatalf("write failure must propagate: %v", err)
	}
}

func TestConcurrentCommandResultsHaveOneWinner(t *testing.T) {
	e := resultDatabase(t)
	seedResultCommand(t, e, "sent", false, nil)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, status := range []string{"success", "error"} {
		wg.Add(1)
		go func(status string) {
			defer wg.Done()
			<-start
			r := validResult()
			r.Status, r.Output = status, status
			results <- updateCommandResult(context.Background(), e, resultAgentB, r)
		}(status)
	}
	close(start)
	wg.Wait()
	close(results)
	wins, conflicts := 0, 0
	for err := range results {
		if err == nil {
			wins++
		} else if errors.Is(err, ErrCommandResultConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wins=%d conflicts=%d", wins, conflicts)
	}
	var status, output string
	if err := e.db.QueryRow(`SELECT status, output FROM commands`).Scan(&status, &output); err != nil || status != output {
		t.Fatalf("mixed result: %q %q %v", status, output, err)
	}
}

func TestScriptApprovalIsPersistedAtCreation(t *testing.T) {
	for _, tc := range []struct {
		typeName shared.CommandType
		dryRun   bool
		approval bool
	}{
		{shared.CmdRunScript, false, true},
		{shared.CmdRunScript, true, false},
		{shared.CommandType("force_report"), false, false},
	} {
		e := resultDatabase(t)
		agent := resultAgentB
		// A nil creator covers commands emitted by the scheduler as well.
		err := insertCommand(context.Background(), e, resultCommand, &agent, nil,
			shared.Command{Type: tc.typeName, DryRun: tc.dryRun}, nil)
		if err != nil {
			t.Fatal(err)
		}
		var approval bool
		if err := e.db.QueryRow(`SELECT requires_approval FROM commands`).Scan(&approval); err != nil || approval != tc.approval {
			t.Fatalf("approval=%v want=%v error=%v", approval, tc.approval, err)
		}
	}
}

func TestPendingScriptApprovalMigrationPreservesExistingWork(t *testing.T) {
	migration, err := os.ReadFile("../migrations/009_pending_script_approval.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, kind, status string
		dryRun, approval   bool
		approvedAt         any
		want               bool
	}{
		{"legacy_pending", "run_script", "pending", false, false, nil, true},
		{"already_required", "run_script", "pending", false, true, nil, true},
		{"approved", "run_script", "pending", false, true, time.Now(), true},
		{"dry_run", "run_script", "pending", true, false, nil, false},
		{"other_type", "force_report", "pending", false, false, nil, false},
		{"sent", "run_script", "sent", false, false, nil, false},
		{"completed", "run_script", "success", false, false, nil, false},
		{"cancelled", "run_script", "cancelled", false, false, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := resultDatabase(t)
			seedResultCommand(t, e, tc.status, tc.approval, tc.approvedAt)
			if _, err := e.db.Exec(`UPDATE commands SET type = ?, dry_run = ?`, tc.kind, tc.dryRun); err != nil {
				t.Fatal(err)
			}
			// Running twice also checks that the data repair is idempotent.
			for i := 0; i < 2; i++ {
				if _, err := e.db.Exec(string(migration)); err != nil {
					t.Fatal(err)
				}
			}
			var approval bool
			var status, output string
			var approvedAt any
			if err := e.db.QueryRow(`SELECT requires_approval, status, output, approved_at FROM commands WHERE id = ?`, resultCommand).
				Scan(&approval, &status, &output, &approvedAt); err != nil {
				t.Fatal(err)
			}
			if approval != tc.want || status != tc.status || output != "original" || (approvedAt == nil) != (tc.approvedAt == nil) {
				t.Fatalf("migration changed unexpected fields: %v %s %s %v", approval, status, output, approvedAt)
			}
		})
	}
}
