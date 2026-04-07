package db

import "context"

// ResolveAgentOfflineAlert resolves existing offline alerts for an agent that came back online.
func (d *DB) ResolveAgentOfflineAlert(ctx context.Context, agentID string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE alerts SET resolved = true, resolved_at = NOW()
		WHERE agent_id = $1 AND type = 'agent_offline' AND resolved = false`, agentID)
	return err
}
