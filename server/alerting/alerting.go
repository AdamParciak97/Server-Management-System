package alerting

import (
	"context"
	"log/slog"
	"time"

	"github.com/sms/server-mgmt/server/db"
)

// Monitor runs periodic checks for offline agents and other conditions.
type Monitor struct {
	db     *db.DB
	logger *slog.Logger
}

func New(database *db.DB, logger *slog.Logger) *Monitor {
	return &Monitor{db: database, logger: logger}
}

func (m *Monitor) Start(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.checkOfflineAgents(ctx)
			m.dispatchPendingAlerts(ctx)
		}
	}
}

func (m *Monitor) checkOfflineAgents(ctx context.Context) {
	threshold := 10 * time.Minute

	count, err := m.db.MarkOfflineAgents(ctx, threshold)
	if err != nil {
		m.logger.Error("mark offline agents", "error", err)
		return
	}
	if count > 0 {
		m.logger.Info("marked agents offline", "count", count)
	}

	// Create alerts for newly offline agents
	agents, err := m.db.ListAgents(ctx)
	if err != nil {
		return
	}

	for _, agent := range agents {
		if agent.Status == "offline" {
			exists, _ := m.db.AlertExists(ctx, &agent.ID, "agent_offline")
			if !exists {
				_ = m.db.CreateAlert(ctx, &agent.ID, "agent_offline", "high",
					"Agent offline: "+agent.Hostname,
					"Agent has not reported for more than "+threshold.String())
			}
		} else if agent.Status == "online" {
			// Resolve offline alert if agent is back
			_ = m.db.ResolveAgentOfflineAlert(ctx, agent.ID)
		}
	}
}
