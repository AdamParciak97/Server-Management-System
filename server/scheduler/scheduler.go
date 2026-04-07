package scheduler

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

type Scheduler struct {
	db     *db.DB
	cron   *cron.Cron
	logger *slog.Logger
}

func New(database *db.DB, logger *slog.Logger) *Scheduler {
	c := cron.New(cron.WithLocation(time.UTC))
	return &Scheduler{db: database, cron: c, logger: logger}
}

func (s *Scheduler) Start(ctx context.Context) error {
	// Load existing scheduled commands from DB and register them
	if err := s.loadScheduledCommands(ctx); err != nil {
		return err
	}
	s.cron.Start()

	// Re-sync every 5 minutes to pick up new scheduled commands
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				s.cron.Stop()
				return
			case <-ticker.C:
				if err := s.loadScheduledCommands(ctx); err != nil {
					s.logger.Error("reload scheduled commands", "error", err)
				}
			}
		}
	}()
	return nil
}

func (s *Scheduler) loadScheduledCommands(ctx context.Context) error {
	// Remove all existing entries and reload
	for _, entry := range s.cron.Entries() {
		s.cron.Remove(entry.ID)
	}

	rows, err := s.db.Pool.Query(ctx, `
		SELECT id, cron_expr, agent_id, group_id, maintenance_window_id, type, priority, payload, dry_run, timeout_seconds
		FROM scheduled_commands WHERE enabled = true`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type scheduledCmd struct {
		ID                  string
		CronExpr            string
		AgentID             *string
		GroupID             *string
		MaintenanceWindowID *string
		Type                string
		Priority            string
		Payload             []byte
		DryRun              bool
		Timeout             int
	}

	var cmds []scheduledCmd
	for rows.Next() {
		var sc scheduledCmd
		if err := rows.Scan(&sc.ID, &sc.CronExpr, &sc.AgentID, &sc.GroupID, &sc.MaintenanceWindowID,
			&sc.Type, &sc.Priority, &sc.Payload, &sc.DryRun, &sc.Timeout); err != nil {
			s.logger.Error("scan scheduled command", "error", err)
			continue
		}
		cmds = append(cmds, sc)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, sc := range cmds {
		sc := sc // capture
		_, err := s.cron.AddFunc(sc.CronExpr, func() {
			s.executeScheduledCommand(sc.ID, sc.AgentID, sc.GroupID, sc.MaintenanceWindowID, sc.Type, sc.Priority, sc.Payload, sc.DryRun, sc.Timeout)
		})
		if err != nil {
			s.logger.Error("add cron job", "id", sc.ID, "expr", sc.CronExpr, "error", err)
		}
	}

	s.logger.Info("loaded scheduled commands", "count", len(cmds))
	return nil
}

func (s *Scheduler) executeScheduledCommand(schedID string, agentID, groupID, maintenanceWindowID *string, cmdType, priority string, payloadBytes []byte, dryRun bool, timeout int) {
	ctx := context.Background()
	now := time.Now().UTC()

	var payload shared.CommandPayload
	_ = json.Unmarshal(payloadBytes, &payload)

	cmd := shared.Command{
		ID:       uuid.New().String(),
		Type:     shared.CommandType(cmdType),
		Priority: shared.CommandPriority(priority),
		DryRun:   dryRun,
		Payload:  payload,
		Timeout:  timeout,
	}

	if maintenanceWindowID != nil {
		window, err := s.db.GetMaintenanceWindow(ctx, *maintenanceWindowID)
		if err != nil {
			s.logger.Error("load maintenance window", "scheduled_id", schedID, "maintenance_window_id", *maintenanceWindowID, "error", err)
			_ = s.db.UpdateScheduledCommandSkip(ctx, schedID, "maintenance window not found", now)
			return
		}
		if !s.db.MaintenanceWindowAllows(ctx, window, now) {
			reason := "outside maintenance window: " + window.Name
			s.logger.Info("skipping scheduled command outside maintenance window", "scheduled_id", schedID, "window", window.Name)
			_ = s.db.UpdateScheduledCommandSkip(ctx, schedID, reason, now)
			return
		}
	}

	if groupID != nil && agentID == nil {
		// Send to all agents in group
		agents, err := s.db.GetAgentsByGroup(ctx, *groupID)
		if err != nil {
			s.logger.Error("get group agents for scheduled cmd", "error", err)
			return
		}
		for _, agent := range agents {
			aid := agent.ID
			if _, err := s.db.CreateCommand(ctx, &aid, nil, cmd, nil); err != nil {
				s.logger.Error("create scheduled command", "agent", aid, "error", err)
			}
		}
	} else {
		if _, err := s.db.CreateCommand(ctx, agentID, nil, cmd, nil); err != nil {
			s.logger.Error("create scheduled command", "error", err)
		}
	}

	// Update last_run
	_ = s.db.UpdateScheduledCommandRun(ctx, schedID, now)
	s.logger.Info("executed scheduled command", "scheduled_id", schedID, "type", cmdType)
}
