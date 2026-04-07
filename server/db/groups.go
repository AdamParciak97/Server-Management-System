package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ServerCount int       `json:"server_count,omitempty"`
}

func (d *DB) CreateGroup(ctx context.Context, name, description string) (*Group, error) {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO groups (id, name, description) VALUES ($1, $2, $3)`,
		id, name, description)
	if err != nil {
		return nil, err
	}
	return &Group{ID: id, Name: name, Description: description, CreatedAt: time.Now()}, nil
}

func (d *DB) ListGroups(ctx context.Context) ([]*Group, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT g.id, g.name, COALESCE(g.description,''), g.created_at,
			COUNT(a.id) as server_count
		FROM groups g
		LEFT JOIN agents a ON a.group_id = g.id
		GROUP BY g.id ORDER BY g.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []*Group
	for rows.Next() {
		var g Group
		err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt, &g.ServerCount)
		if err != nil {
			return nil, err
		}
		groups = append(groups, &g)
	}
	return groups, rows.Err()
}

func (d *DB) GetGroup(ctx context.Context, id string) (*Group, error) {
	var g Group
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, COALESCE(description,''), created_at FROM groups WHERE id = $1`, id).
		Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt)
	return &g, err
}

func (d *DB) DeleteGroup(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM groups WHERE id = $1`, id)
	return err
}

func (d *DB) AssignAgentToGroup(ctx context.Context, agentID, groupID string) error {
	var groupValue interface{}
	if groupID != "" {
		groupValue = groupID
	}
	_, err := d.Pool.Exec(ctx, `UPDATE agents SET group_id = $2 WHERE id = $1`, agentID, groupValue)
	return err
}

func (d *DB) GetAgentsByGroup(ctx context.Context, groupID string) ([]*Agent, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT a.id, a.hostname, COALESCE(a.fqdn,''), a.ip_addresses,
			COALESCE(a.os,''), COALESCE(a.os_version,''), COALESCE(a.architecture,''),
			COALESCE(a.agent_version,''), a.group_id, COALESCE(g.name,''),
			COALESCE(a.tags, '{}'), COALESCE(a.cert_fingerprint,''),
			a.last_seen, a.status, a.registered_at
		FROM agents a
		LEFT JOIN groups g ON a.group_id = g.id
		WHERE a.group_id = $1`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var agents []*Agent
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, rows.Err()
}

// ─── Required security agents ─────────────────────────────────────────────────

type RequiredAgent struct {
	ID        string    `json:"id"`
	GroupID   string    `json:"group_id"`
	AgentName string    `json:"agent_name"`
	CreatedAt time.Time `json:"created_at"`
}

func (d *DB) SetRequiredAgents(ctx context.Context, groupID string, agents []string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `DELETE FROM required_security_agents WHERE group_id = $1`, groupID)
	if err != nil {
		return err
	}
	for _, name := range agents {
		_, err = tx.Exec(ctx, `
			INSERT INTO required_security_agents (id, group_id, agent_name)
			VALUES ($1, $2, $3)`, uuid.New().String(), groupID, name)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (d *DB) GetRequiredAgents(ctx context.Context, groupID string) ([]string, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT agent_name FROM required_security_agents WHERE group_id = $1`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}
