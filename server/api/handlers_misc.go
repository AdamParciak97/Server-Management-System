package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
)


// ─── Alerts ───────────────────────────────────────────────────────────────────

func (s *Server) handleListAlerts(w http.ResponseWriter, r *http.Request) {
	onlyActive := r.URL.Query().Get("active") != "false"
	alerts, err := s.db.ListAlerts(r.Context(), onlyActive)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list alerts")
		return
	}
	if alerts == nil {
		alerts = []*db.Alert{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.Alert, 0, len(alerts))
		for _, alert := range alerts {
			if alert.AgentID == nil {
				continue
			}
			agent, err := s.db.GetAgent(r.Context(), *alert.AgentID)
			if err == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
				filtered = append(filtered, alert)
			}
		}
		alerts = filtered
	}
	respondOK(w, alerts)
}

func (s *Server) handleAcknowledgeAlert(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		alerts, err := s.db.ListAlerts(r.Context(), false)
		if err == nil {
			allowed := false
			for _, alert := range alerts {
				if alert.ID != id || alert.AgentID == nil {
					continue
				}
				agent, agentErr := s.db.GetAgent(r.Context(), *alert.AgentID)
				if agentErr == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
					allowed = true
					break
				}
			}
			if !allowed {
				respondError(w, http.StatusForbidden, "alert outside allowed scope")
				return
			}
		}
	}
	user := getUserFromCtx(r.Context())
	userID := ""
	if user != nil {
		userID = user.UserID
	}
	if err := s.db.AcknowledgeAlert(r.Context(), id, userID); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to acknowledge alert")
		return
	}
	respondOK(w, map[string]string{"status": "acknowledged"})
}

// ─── Packages ─────────────────────────────────────────────────────────────────

func (s *Server) handlePackageUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(500 << 20); err != nil { // 500MB
		respondError(w, http.StatusBadRequest, "failed to parse form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	name := r.FormValue("name")
	version := r.FormValue("version")
	osTarget := r.FormValue("os_target")
	archTarget := r.FormValue("arch_target")
	description := r.FormValue("description")

	if name == "" || version == "" {
		respondError(w, http.StatusBadRequest, "name and version required")
		return
	}

	// Read file and compute hash
	data, err := io.ReadAll(file)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	h := sha256.Sum256(data)
	sha256str := fmt.Sprintf("%x", h)

	// Save file
	if err := os.MkdirAll(s.uploadDir, 0755); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create upload dir")
		return
	}
	filename := fmt.Sprintf("%s_%s_%s", uuid.New().String(), name, filepath.Base(header.Filename))
	filePath := filepath.Join(s.uploadDir, filename)
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to save file")
		return
	}

	user := getUserFromCtx(r.Context())
	var uploaderID *string
	if user != nil {
		uploaderID = &user.UserID
	}

	pkg, err := s.db.CreatePackage(r.Context(), db.PackageRecord{
		Name:        name,
		Version:     version,
		OSTarget:    osTarget,
		ArchTarget:  archTarget,
		FilePath:    filePath,
		FileSize:    int64(len(data)),
		SHA256:      sha256str,
		Description: description,
		UploadedBy:  uploaderID,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to save package record")
		return
	}

	respondOK(w, pkg)
}

func (s *Server) handleListPackages(w http.ResponseWriter, r *http.Request) {
	pkgs, err := s.db.ListPackages(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list packages")
		return
	}
	if pkgs == nil {
		pkgs = []*db.PackageRecord{}
	}
	respondOK(w, pkgs)
}

func (s *Server) handlePackageDownload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	pkg, err := s.db.GetPackage(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "package not found")
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filepath.Base(pkg.FilePath)))
	http.ServeFile(w, r, pkg.FilePath)
}

func (s *Server) handleDeletePackage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	pkg, err := s.db.GetPackage(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "package not found")
		return
	}
	if err := s.db.DeletePackage(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete package")
		return
	}
	if pkg.FilePath != "" {
		_ = os.Remove(pkg.FilePath)
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

// ─── Users ────────────────────────────────────────────────────────────────────

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.db.ListUsers(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	if users == nil {
		users = []*db.User{}
	}
	respondOK(w, users)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		Role     string `json:"role"`
		Permissions []string `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Username == "" || req.Password == "" || req.Email == "" {
		respondError(w, http.StatusBadRequest, "username, email and password required")
		return
	}
	if req.Role == "" {
		req.Role = "readonly"
	}

	user, err := s.db.CreateUser(r.Context(), req.Username, req.Email, req.Password, req.Role)
	if err != nil {
		s.logger.Error("create user", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	if len(req.Permissions) > 0 {
		if err := s.db.SetUserPermissions(r.Context(), user.ID, req.Permissions); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to save user permissions")
			return
		}
	}
	respondOK(w, user)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	caller := getUserFromCtx(r.Context())
	if caller != nil && caller.UserID == id {
		respondError(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}
	if err := s.db.DeleteUser(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleListUserPermissions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	items, err := s.db.ListUserPermissions(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list permissions")
		return
	}
	respondOK(w, map[string]interface{}{
		"permissions": items,
		"defaults":    db.DefaultPermissionsForRole(getUserRoleForPermissionView(r.Context(), s, id)),
	})
}

func (s *Server) handleSetUserPermissions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Permissions []string `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := s.db.SetUserPermissions(r.Context(), id, req.Permissions); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to save permissions")
		return
	}
	respondOK(w, map[string]string{"status": "saved"})
}

func (s *Server) handleListUserScopes(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	items, err := s.db.ListUserGroupScopes(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list user scopes")
		return
	}
	respondOK(w, map[string]interface{}{"group_ids": items})
}

func (s *Server) handleSetUserScopes(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		GroupIDs []string `json:"group_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := s.db.SetUserGroupScopes(r.Context(), id, req.GroupIDs); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to save user scopes")
		return
	}
	respondOK(w, map[string]string{"status": "saved"})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if len(req.NewPassword) < 8 {
		respondError(w, http.StatusBadRequest, "new password must be at least 8 characters")
		return
	}

	user := getUserFromCtx(r.Context())
	if user == nil {
		respondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	userRecord, err := s.db.GetUserByID(r.Context(), user.UserID)
	if err != nil {
		respondError(w, http.StatusNotFound, "user not found")
		return
	}
	if userRecord.AuthSource == "ldap" {
		respondError(w, http.StatusBadRequest, "password is managed by ldap for this account")
		return
	}

	hash, err := s.db.GetUserPasswordHash(r.Context(), user.UserID)
	if err != nil {
		respondError(w, http.StatusNotFound, "user not found")
		return
	}
	if !s.db.VerifyPassword(hash, req.CurrentPassword) {
		respondError(w, http.StatusBadRequest, "current password is incorrect")
		return
	}
	if err := s.db.UpdateUserPassword(r.Context(), user.UserID, req.NewPassword); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to change password")
		return
	}
	respondOK(w, map[string]string{"status": "password_changed"})
}

func (s *Server) handleGetLDAPSettings(w http.ResponseWriter, r *http.Request) {
	values, err := s.db.GetAllSystemConfig(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load ldap settings")
		return
	}
	respondOK(w, map[string]string{
		"ldap_enabled":       values["ldap_enabled"],
		"ldap_server_url":    values["ldap_server_url"],
		"ldap_bind_dn":       values["ldap_bind_dn"],
		"ldap_bind_password": values["ldap_bind_password"],
		"ldap_base_dn":       values["ldap_base_dn"],
		"ldap_user_filter":   values["ldap_user_filter"],
		"ldap_start_tls":     values["ldap_start_tls"],
		"ldap_default_role":  values["ldap_default_role"],
	})
}

func (s *Server) handleSetLDAPSettings(w http.ResponseWriter, r *http.Request) {
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	keys := []string{
		"ldap_enabled", "ldap_server_url", "ldap_bind_dn", "ldap_bind_password",
		"ldap_base_dn", "ldap_user_filter", "ldap_start_tls", "ldap_default_role",
	}
	for _, key := range keys {
		if err := s.db.SetSystemConfig(r.Context(), key, req[key]); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to save ldap settings")
			return
		}
	}
	respondOK(w, map[string]string{"status": "saved"})
}

func (s *Server) handleListLDAPGroupMappings(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListLDAPGroupMappings(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load ldap group mappings")
		return
	}
	if items == nil {
		items = []*db.LDAPGroupMapping{}
	}
	respondOK(w, items)
}

func (s *Server) handleCreateLDAPGroupMapping(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LDAPGroupDN string `json:"ldap_group_dn"`
		Role        string `json:"role"`
		GroupID     string `json:"group_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.LDAPGroupDN == "" || req.Role == "" {
		respondError(w, http.StatusBadRequest, "ldap_group_dn and role are required")
		return
	}
	var groupID *string
	if req.GroupID != "" {
		groupID = &req.GroupID
	}
	item, err := s.db.CreateLDAPGroupMapping(r.Context(), req.LDAPGroupDN, req.Role, groupID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create ldap group mapping")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleDeleteLDAPGroupMapping(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteLDAPGroupMapping(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete ldap group mapping")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleGetSMTPSettings(w http.ResponseWriter, r *http.Request) {
	values, err := s.db.GetAllSystemConfig(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load smtp settings")
		return
	}
	respondOK(w, map[string]string{
		"smtp_enabled":  values["smtp_enabled"],
		"smtp_host":     values["smtp_host"],
		"smtp_port":     values["smtp_port"],
		"smtp_username": values["smtp_username"],
		"smtp_password": values["smtp_password"],
		"smtp_from":     values["smtp_from"],
		"smtp_to":       values["smtp_to"],
	})
}

func (s *Server) handleSetSMTPSettings(w http.ResponseWriter, r *http.Request) {
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	keys := []string{
		"smtp_enabled", "smtp_host", "smtp_port", "smtp_username",
		"smtp_password", "smtp_from", "smtp_to",
	}
	for _, key := range keys {
		if err := s.db.SetSystemConfig(r.Context(), key, req[key]); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to save smtp settings")
			return
		}
	}
	respondOK(w, map[string]string{"status": "saved"})
}

func (s *Server) handlePermissionCatalog(w http.ResponseWriter, r *http.Request) {
	respondOK(w, db.AllPermissions())
}

func getUserRoleForPermissionView(ctx context.Context, s *Server, userID string) string {
	user, err := s.db.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		return "readonly"
	}
	return user.Role
}

// ─── Groups ───────────────────────────────────────────────────────────────────

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.db.ListGroups(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list groups")
		return
	}
	if groups == nil {
		groups = []*db.Group{}
	}
	respondOK(w, s.filterGroupsByScope(s.getClaims(r.Context()), groups))
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		respondError(w, http.StatusBadRequest, "name required")
		return
	}
	group, err := s.db.CreateGroup(r.Context(), req.Name, req.Description)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create group")
		return
	}
	respondOK(w, group)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteGroup(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete group")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleSetRequiredAgents(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Agents []string `json:"agents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := s.db.SetRequiredAgents(r.Context(), id, req.Agents); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to set required agents")
		return
	}
	respondOK(w, map[string]string{"status": "ok"})
}

func (s *Server) handleListCompliancePolicies(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListCompliancePolicies(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list policies")
		return
	}
	if items == nil {
		items = []*db.CompliancePolicy{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.CompliancePolicy, 0, len(items))
		for _, item := range items {
			if item.GroupID == nil || s.canAccessGroup(s.getClaims(r.Context()), item.GroupID) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	respondOK(w, items)
}

func (s *Server) handleCreateCompliancePolicy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string `json:"name"`
		GroupID       string `json:"group_id"`
		PolicyType    string `json:"policy_type"`
		Subject       string `json:"subject"`
		ExpectedValue string `json:"expected_value"`
		Severity      string `json:"severity"`
		Enabled       *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name == "" || req.PolicyType == "" || req.Subject == "" {
		respondError(w, http.StatusBadRequest, "name, policy_type and subject are required")
		return
	}

	var groupID *string
	if req.GroupID != "" {
		groupID = &req.GroupID
		if !s.canAccessGroup(s.getClaims(r.Context()), groupID) {
			respondError(w, http.StatusForbidden, "group outside allowed scope")
			return
		}
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	severity := req.Severity
	if severity == "" {
		severity = "medium"
	}

	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	item, err := s.db.CreateCompliancePolicy(r.Context(), db.CompliancePolicy{
		Name:          req.Name,
		GroupID:       groupID,
		PolicyType:    req.PolicyType,
		Subject:       req.Subject,
		ExpectedValue: req.ExpectedValue,
		Severity:      severity,
		Enabled:       enabled,
		CreatedBy:     createdBy,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create policy")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleDeleteCompliancePolicy(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		policies, err := s.db.ListCompliancePolicies(r.Context())
		if err == nil {
			for _, policy := range policies {
				if policy.ID == id && policy.GroupID != nil && !s.canAccessGroup(s.getClaims(r.Context()), policy.GroupID) {
					respondError(w, http.StatusForbidden, "policy outside allowed scope")
					return
				}
			}
		}
	}
	if err := s.db.DeleteCompliancePolicy(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete policy")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleListComplianceExceptions(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListComplianceExceptions(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list compliance exceptions")
		return
	}
	if items == nil {
		items = []*db.ComplianceException{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.ComplianceException, 0, len(items))
		for _, item := range items {
			agent, err := s.db.GetAgent(r.Context(), item.AgentID)
			if err == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	respondOK(w, items)
}

func (s *Server) handleCreateComplianceException(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PolicyID   string `json:"policy_id"`
		AgentID    string `json:"agent_id"`
		Reason     string `json:"reason"`
		ExpiresAt  string `json:"expires_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.PolicyID == "" || req.AgentID == "" || strings.TrimSpace(req.Reason) == "" {
		respondError(w, http.StatusBadRequest, "policy_id, agent_id and reason are required")
		return
	}
	agent, err := s.db.GetAgent(r.Context(), req.AgentID)
	if err != nil {
		respondError(w, http.StatusNotFound, "server not found")
		return
	}
	if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
		respondError(w, http.StatusForbidden, "server outside allowed scope")
		return
	}
	policies, err := s.db.ListCompliancePolicies(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load compliance policies")
		return
	}
	var matchedPolicy *db.CompliancePolicy
	for _, policy := range policies {
		if policy != nil && policy.ID == req.PolicyID {
			matchedPolicy = policy
			break
		}
	}
	if matchedPolicy == nil {
		respondError(w, http.StatusNotFound, "policy not found")
		return
	}
	if matchedPolicy.GroupID != nil {
		if agent.GroupID == nil || *matchedPolicy.GroupID != *agent.GroupID {
			respondError(w, http.StatusBadRequest, "policy does not apply to this server group")
			return
		}
		if !s.canAccessGroup(s.getClaims(r.Context()), matchedPolicy.GroupID) {
			respondError(w, http.StatusForbidden, "policy outside allowed scope")
			return
		}
	}

	var expiresAt *time.Time
	if strings.TrimSpace(req.ExpiresAt) != "" {
		parsed, err := time.Parse(time.RFC3339, req.ExpiresAt)
		if err != nil {
			respondError(w, http.StatusBadRequest, "expires_at must be RFC3339")
			return
		}
		expiresAt = &parsed
	}

	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	item, err := s.db.CreateComplianceException(r.Context(), req.PolicyID, req.AgentID, strings.TrimSpace(req.Reason), expiresAt, createdBy)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create compliance exception")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleDeleteComplianceException(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		items, err := s.db.ListComplianceExceptions(r.Context())
		if err == nil {
			for _, item := range items {
				if item == nil || item.ID != id {
					continue
				}
				agent, agentErr := s.db.GetAgent(r.Context(), item.AgentID)
				if agentErr != nil || !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
					respondError(w, http.StatusForbidden, "exception outside allowed scope")
					return
				}
				break
			}
		}
	}
	if err := s.db.DeleteComplianceException(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete compliance exception")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

// ─── Registration Tokens ──────────────────────────────────────────────────────

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.db.ListRegistrationTokens(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list tokens")
		return
	}
	if tokens == nil {
		tokens = []*db.RegToken{}
	}
	respondOK(w, tokens)
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ExpiresAt *time.Time `json:"expires_at,omitempty"`
		Note      string     `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	user := getUserFromCtx(r.Context())
	var userID *string
	if user != nil {
		userID = &user.UserID
	}

	token, err := s.db.CreateRegistrationToken(r.Context(), userID, req.ExpiresAt, req.Note)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create token")
		return
	}
	respondOK(w, token)
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	action := r.URL.Query().Get("action")
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")

	var from, to time.Time
	if fromStr != "" {
		from, _ = time.Parse(time.RFC3339, fromStr)
	}
	if toStr != "" {
		to, _ = time.Parse(time.RFC3339, toStr)
	}

	entries, err := s.db.ListAudit(r.Context(), userID, action, from, to, 0)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list audit log")
		return
	}
	if entries == nil {
		entries = []*db.AuditEntry{}
	}
	respondOK(w, entries)
}
