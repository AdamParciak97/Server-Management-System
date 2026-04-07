package api

import (
	"context"
	"crypto/tls"
	"fmt"
	"slices"
	"strings"

	"github.com/go-ldap/ldap/v3"
	"github.com/sms/server-mgmt/server/db"
)

type ldapSettings struct {
	Enabled      bool
	ServerURL    string
	BindDN       string
	BindPassword string
	BaseDN       string
	UserFilter   string
	StartTLS     bool
	DefaultRole  string
}

func (s *Server) loadLDAPSettings(ctx context.Context) (ldapSettings, error) {
	values, err := s.db.GetAllSystemConfig(ctx)
	if err != nil {
		return ldapSettings{}, err
	}
	settings := ldapSettings{
		Enabled:     strings.EqualFold(values["ldap_enabled"], "true"),
		ServerURL:   values["ldap_server_url"],
		BindDN:      values["ldap_bind_dn"],
		BindPassword: values["ldap_bind_password"],
		BaseDN:      values["ldap_base_dn"],
		UserFilter:  values["ldap_user_filter"],
		StartTLS:    strings.EqualFold(values["ldap_start_tls"], "true"),
		DefaultRole: values["ldap_default_role"],
	}
	if settings.UserFilter == "" {
		settings.UserFilter = "(sAMAccountName=%s)"
	}
	if settings.DefaultRole == "" {
		settings.DefaultRole = "readonly"
	}
	return settings, nil
}

func (s *Server) authenticateLDAP(ctx context.Context, username, password string) (*db.User, error) {
	settings, err := s.loadLDAPSettings(ctx)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled || settings.ServerURL == "" || settings.BaseDN == "" {
		return nil, fmt.Errorf("ldap is not configured")
	}

	conn, err := ldap.DialURL(settings.ServerURL)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if settings.StartTLS {
		if err := conn.StartTLS(&tls.Config{MinVersion: tls.VersionTLS12}); err != nil {
			return nil, err
		}
	}

	if settings.BindDN != "" {
		if err := conn.Bind(settings.BindDN, settings.BindPassword); err != nil {
			return nil, err
		}
	}

	filter := fmt.Sprintf(settings.UserFilter, ldap.EscapeFilter(username))
	req := ldap.NewSearchRequest(
		settings.BaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		1,
		0,
		false,
		filter,
		[]string{"dn", "mail", "userPrincipalName", "cn", "memberOf"},
		nil,
	)
	result, err := conn.Search(req)
	if err != nil {
		return nil, err
	}
	if len(result.Entries) != 1 {
		return nil, fmt.Errorf("ldap user not found")
	}
	entry := result.Entries[0]
	userDN := entry.DN
	if userDN == "" {
		return nil, fmt.Errorf("ldap user dn missing")
	}
	if err := conn.Bind(userDN, password); err != nil {
		return nil, err
	}

	email := firstNonEmpty(entry.GetAttributeValue("mail"), entry.GetAttributeValue("userPrincipalName"), username+"@ldap.local")
	role := settings.DefaultRole
	groupScopes := []string{}
	if mappings, err := s.db.ListLDAPGroupMappings(ctx); err == nil {
		role, groupScopes = resolveLDAPMappings(entry.GetAttributeValues("memberOf"), settings.DefaultRole, mappings)
	}
	user, err := s.db.CreateOrUpdateLDAPUser(ctx, username, email, role)
	if err != nil {
		return nil, err
	}
	if err := s.db.SetUserGroupScopes(ctx, user.ID, groupScopes); err != nil {
		return nil, err
	}
	return user, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func resolveLDAPMappings(memberOf []string, defaultRole string, mappings []*db.LDAPGroupMapping) (string, []string) {
	role := defaultRole
	roleWeight := map[string]int{"readonly": 1, "operator": 2, "admin": 3}
	scopeSeen := map[string]bool{}
	scopes := []string{}

	for _, member := range memberOf {
		for _, mapping := range mappings {
			if !strings.EqualFold(strings.TrimSpace(member), strings.TrimSpace(mapping.LDAPGroupDN)) {
				continue
			}
			if roleWeight[mapping.Role] > roleWeight[role] {
				role = mapping.Role
			}
			if mapping.GroupID != nil && *mapping.GroupID != "" && !scopeSeen[*mapping.GroupID] {
				scopeSeen[*mapping.GroupID] = true
				scopes = append(scopes, *mapping.GroupID)
			}
		}
	}

	slices.Sort(scopes)
	return role, scopes
}
