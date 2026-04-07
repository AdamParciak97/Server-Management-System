package db

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

type LDAPGroupMapping struct {
	ID          string     `json:"id"`
	LDAPGroupDN string     `json:"ldap_group_dn"`
	Role        string     `json:"role"`
	GroupID     *string    `json:"group_id,omitempty"`
	GroupName   string     `json:"group_name,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

func (d *DB) ListUserGroupScopes(ctx context.Context, userID string) ([]string, error) {
	rows, err := d.Pool.Query(ctx, `SELECT group_id::text FROM user_group_scopes WHERE user_id = $1 ORDER BY group_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var groupID string
		if err := rows.Scan(&groupID); err != nil {
			return nil, err
		}
		out = append(out, groupID)
	}
	return out, rows.Err()
}

func (d *DB) SetUserGroupScopes(ctx context.Context, userID string, groupIDs []string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM user_group_scopes WHERE user_id = $1`, userID); err != nil {
		return err
	}
	for _, groupID := range groupIDs {
		if strings.TrimSpace(groupID) == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_group_scopes (user_id, group_id)
			VALUES ($1, $2)`, userID, groupID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (d *DB) ListLDAPGroupMappings(ctx context.Context) ([]*LDAPGroupMapping, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT m.id, m.ldap_group_dn, m.role, m.group_id, COALESCE(g.name,''), m.created_at
		FROM ldap_group_mappings m
		LEFT JOIN groups g ON g.id = m.group_id
		ORDER BY m.ldap_group_dn`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*LDAPGroupMapping
	for rows.Next() {
		var item LDAPGroupMapping
		if err := rows.Scan(&item.ID, &item.LDAPGroupDN, &item.Role, &item.GroupID, &item.GroupName, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &item)
	}
	return out, rows.Err()
}

func (d *DB) CreateLDAPGroupMapping(ctx context.Context, ldapGroupDN, role string, groupID *string) (*LDAPGroupMapping, error) {
	id := uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO ldap_group_mappings (id, ldap_group_dn, role, group_id)
		VALUES ($1, $2, $3, $4)`, id, ldapGroupDN, role, groupID)
	if err != nil {
		return nil, err
	}
	return d.GetLDAPGroupMapping(ctx, id)
}

func (d *DB) GetLDAPGroupMapping(ctx context.Context, id string) (*LDAPGroupMapping, error) {
	var item LDAPGroupMapping
	err := d.Pool.QueryRow(ctx, `
		SELECT m.id, m.ldap_group_dn, m.role, m.group_id, COALESCE(g.name,''), m.created_at
		FROM ldap_group_mappings m
		LEFT JOIN groups g ON g.id = m.group_id
		WHERE m.id = $1`, id).
		Scan(&item.ID, &item.LDAPGroupDN, &item.Role, &item.GroupID, &item.GroupName, &item.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (d *DB) DeleteLDAPGroupMapping(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM ldap_group_mappings WHERE id = $1`, id)
	return err
}
