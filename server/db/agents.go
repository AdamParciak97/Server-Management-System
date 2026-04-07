package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type Agent struct {
	ID             string    `json:"id"`
	Hostname       string    `json:"hostname"`
	FQDN           string    `json:"fqdn"`
	IPAddresses    []string  `json:"ip_addresses"`
	OS             string    `json:"os"`
	OSVersion      string    `json:"os_version"`
	Architecture   string    `json:"architecture"`
	AgentVersion   string    `json:"agent_version"`
	GroupID        *string   `json:"group_id,omitempty"`
	GroupName      string    `json:"group_name,omitempty"`
	Tags           []string  `json:"tags"`
	CertFingerprint string   `json:"cert_fingerprint,omitempty"`
	LastSeen       *time.Time `json:"last_seen,omitempty"`
	Status         string    `json:"status"`
	RegisteredAt   time.Time `json:"registered_at"`
	AlertCount     int       `json:"alert_count,omitempty"`
}

func (d *DB) RegisterAgent(ctx context.Context, hostname, certFP, version string) (*Agent, error) {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO agents (id, hostname, agent_version, cert_fingerprint, status)
		VALUES ($1, $2, $3, $4, 'online')
		ON CONFLICT (id) DO NOTHING`,
		id, hostname, version, certFP)
	if err != nil {
		return nil, err
	}
	return d.GetAgent(ctx, id)
}

func (d *DB) GetAgent(ctx context.Context, id string) (*Agent, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT a.id, a.hostname, COALESCE(a.fqdn,''), a.ip_addresses,
			COALESCE(a.os,''), COALESCE(a.os_version,''), COALESCE(a.architecture,''),
			COALESCE(a.agent_version,''), a.group_id, COALESCE(g.name,''),
			COALESCE(a.tags, '{}'), COALESCE(a.cert_fingerprint,''),
			a.last_seen, a.status, a.registered_at
		FROM agents a
		LEFT JOIN groups g ON a.group_id = g.id
		WHERE a.id = $1`, id)
	return scanAgent(row)
}

func (d *DB) GetAgentByCert(ctx context.Context, fingerprint string) (*Agent, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT a.id, a.hostname, COALESCE(a.fqdn,''), a.ip_addresses,
			COALESCE(a.os,''), COALESCE(a.os_version,''), COALESCE(a.architecture,''),
			COALESCE(a.agent_version,''), a.group_id, COALESCE(g.name,''),
			COALESCE(a.tags, '{}'), COALESCE(a.cert_fingerprint,''),
			a.last_seen, a.status, a.registered_at
		FROM agents a
		LEFT JOIN groups g ON a.group_id = g.id
		WHERE a.cert_fingerprint = $1`, fingerprint)
	return scanAgent(row)
}

func (d *DB) ListAgents(ctx context.Context) ([]*Agent, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT a.id, a.hostname, COALESCE(a.fqdn,''), a.ip_addresses,
			COALESCE(a.os,''), COALESCE(a.os_version,''), COALESCE(a.architecture,''),
			COALESCE(a.agent_version,''), a.group_id, COALESCE(g.name,''),
			COALESCE(a.tags, '{}'), COALESCE(a.cert_fingerprint,''),
			a.last_seen, a.status, a.registered_at
		FROM agents a
		LEFT JOIN groups g ON a.group_id = g.id
		ORDER BY a.hostname`)
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

func (d *DB) UpdateAgentLastSeen(ctx context.Context, id string, info map[string]interface{}) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE agents SET
			last_seen = NOW(),
			status = 'online',
			updated_at = NOW(),
			hostname = COALESCE($2, hostname),
			fqdn = COALESCE($3, fqdn),
			ip_addresses = COALESCE($4, ip_addresses),
			os = COALESCE($5, os),
			os_version = COALESCE($6, os_version),
			architecture = COALESCE($7, architecture),
			agent_version = COALESCE($8, agent_version)
		WHERE id = $1`,
		id,
		info["hostname"], info["fqdn"], info["ips"],
		info["os"], info["os_version"], info["architecture"], info["agent_version"])
	return err
}

func (d *DB) MarkOfflineAgents(ctx context.Context, threshold time.Duration) (int, error) {
	tag, err := d.Pool.Exec(ctx, `
		UPDATE agents SET status = 'offline', updated_at = NOW()
		WHERE status = 'online'
		  AND last_seen < NOW() - $1::interval
		  AND last_seen IS NOT NULL`,
		threshold.String())
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (d *DB) ValidateRegistrationToken(ctx context.Context, token string) (bool, error) {
	var used bool
	err := d.Pool.QueryRow(ctx, `
		SELECT used FROM registration_tokens
		WHERE token = $1
		  AND (expires_at IS NULL OR expires_at > NOW())`, token).Scan(&used)
	if err != nil {
		return false, err
	}
	return !used, nil
}

func (d *DB) ConsumeRegistrationToken(ctx context.Context, token, agentID string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE registration_tokens SET used = true, used_at = NOW(), used_by = $2
		WHERE token = $1`, token, agentID)
	return err
}

type scannable interface {
	Scan(dest ...any) error
}

func scanAgent(row scannable) (*Agent, error) {
	var a Agent
	var groupID *string
	err := row.Scan(
		&a.ID, &a.Hostname, &a.FQDN, &a.IPAddresses,
		&a.OS, &a.OSVersion, &a.Architecture, &a.AgentVersion,
		&groupID, &a.GroupName, &a.Tags, &a.CertFingerprint,
		&a.LastSeen, &a.Status, &a.RegisteredAt)
	if err != nil {
		return nil, err
	}
	a.GroupID = groupID
	return &a, nil
}
