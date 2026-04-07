package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

func (s *Server) handleCreateCommandTemplate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string                 `json:"name"`
		Description string                 `json:"description"`
		Type        string                 `json:"type"`
		Priority    string                 `json:"priority"`
		DryRun      bool                   `json:"dry_run"`
		Timeout     int                    `json:"timeout_seconds"`
		Payload     map[string]interface{} `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name == "" || req.Type == "" {
		respondError(w, http.StatusBadRequest, "name and type are required")
		return
	}

	priority := req.Priority
	if priority == "" {
		priority = string(shared.PriorityNormal)
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 1800
	}

	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	item, err := s.db.CreateCommandTemplate(r.Context(), &db.CommandTemplate{
		Name:           req.Name,
		Description:    req.Description,
		Type:           req.Type,
		Priority:       priority,
		Payload:        req.Payload,
		DryRun:         req.DryRun,
		TimeoutSeconds: timeout,
		CreatedBy:      createdBy,
	})
	if err != nil {
		s.logger.Error("create command template", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create command template")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleListCommandTemplates(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListCommandTemplates(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list command templates")
		return
	}
	if items == nil {
		items = []*db.CommandTemplate{}
	}
	respondOK(w, items)
}

func (s *Server) handleDeleteCommandTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteCommandTemplate(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete command template")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleCreateCommand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID  string                 `json:"agent_id"`
		GroupID  string                 `json:"group_id"`
		Type     string                 `json:"type"`
		Priority string                 `json:"priority"`
		DryRun   bool                   `json:"dry_run"`
		Timeout  int                    `json:"timeout_seconds"`
		Payload  map[string]interface{} `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if req.AgentID == "" && req.GroupID == "" {
		respondError(w, http.StatusBadRequest, "agent_id or group_id required")
		return
	}
	if req.Type == "" {
		respondError(w, http.StatusBadRequest, "type required")
		return
	}
	claims := s.getClaims(r.Context())
	if req.AgentID != "" {
		agent, err := s.db.GetAgent(r.Context(), req.AgentID)
		if err != nil {
			respondError(w, http.StatusNotFound, "server not found")
			return
		}
		if !s.canAccessGroup(claims, agent.GroupID) {
			respondError(w, http.StatusForbidden, "server outside allowed scope")
			return
		}
	}
	if req.GroupID != "" && !s.canAccessGroup(claims, &req.GroupID) {
		respondError(w, http.StatusForbidden, "group outside allowed scope")
		return
	}

	priority := shared.CommandPriority(req.Priority)
	if priority == "" {
		priority = shared.PriorityNormal
	}
	timeout := req.Timeout
	if timeout == 0 {
		timeout = 1800
	}

	payloadBytes, _ := json.Marshal(req.Payload)
	var payload shared.CommandPayload
	_ = json.Unmarshal(payloadBytes, &payload)

	cmd := shared.Command{
		Type:     shared.CommandType(req.Type),
		Priority: priority,
		DryRun:   req.DryRun,
		Payload:  payload,
		Timeout:  timeout,
	}

	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	var agentID, groupID *string
	if req.AgentID != "" {
		agentID = &req.AgentID
	}
	if req.GroupID != "" {
		groupID = &req.GroupID
	}

	// If group command, create for each agent in group
	if groupID != nil && agentID == nil {
		agents, err := s.db.GetAgentsByGroup(r.Context(), req.GroupID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to get group agents")
			return
		}
		var createdCmds []*db.DBCommand
		for _, agent := range agents {
			aid := agent.ID
			c, err := s.db.CreateCommand(r.Context(), &aid, nil, cmd, createdBy)
			if err == nil {
				if req.Type == string(shared.CmdRunScript) && !req.DryRun {
					_ = s.db.RequireCommandApproval(r.Context(), c.ID)
					c.RequiresApproval = true
				}
				createdCmds = append(createdCmds, c)
			}
		}
		respondOK(w, map[string]interface{}{"commands_created": len(createdCmds)})
		return
	}

	dbCmd, err := s.db.CreateCommand(r.Context(), agentID, groupID, cmd, createdBy)
	if err != nil {
		s.logger.Error("create command", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create command")
		return
	}
	if req.Type == string(shared.CmdRunScript) && !req.DryRun {
		if err := s.db.RequireCommandApproval(r.Context(), dbCmd.ID); err != nil {
			s.logger.Error("require approval", "command_id", dbCmd.ID, "error", err)
			respondError(w, http.StatusInternalServerError, "failed to queue approval workflow")
			return
		}
		dbCmd.RequiresApproval = true
		dbCmd.ApprovedAt = nil
	}
	respondOK(w, dbCmd)
}

func (s *Server) handleCreateScheduled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string                 `json:"name"`
		CronExpr string                 `json:"cron_expr"`
		AgentID  string                 `json:"agent_id"`
		GroupID  string                 `json:"group_id"`
		MaintenanceWindowID string      `json:"maintenance_window_id"`
		Type     string                 `json:"type"`
		Priority string                 `json:"priority"`
		DryRun   bool                   `json:"dry_run"`
		Timeout  int                    `json:"timeout_seconds"`
		Payload  map[string]interface{} `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.CronExpr == "" || req.Type == "" || req.Name == "" {
		respondError(w, http.StatusBadRequest, "name, cron_expr and type are required")
		return
	}
	claims := s.getClaims(r.Context())
	if req.AgentID != "" {
		agent, err := s.db.GetAgent(r.Context(), req.AgentID)
		if err != nil {
			respondError(w, http.StatusNotFound, "server not found")
			return
		}
		if !s.canAccessGroup(claims, agent.GroupID) {
			respondError(w, http.StatusForbidden, "server outside allowed scope")
			return
		}
	}
	if req.GroupID != "" && !s.canAccessGroup(claims, &req.GroupID) {
		respondError(w, http.StatusForbidden, "group outside allowed scope")
		return
	}
	var maintenanceWindowID interface{} = nil
	if req.MaintenanceWindowID != "" {
		window, err := s.db.GetMaintenanceWindow(r.Context(), req.MaintenanceWindowID)
		if err != nil {
			respondError(w, http.StatusNotFound, "maintenance window not found")
			return
		}
		if window.AgentID != nil {
			if req.AgentID == "" || *window.AgentID != req.AgentID {
				respondError(w, http.StatusBadRequest, "maintenance window does not match selected server")
				return
			}
		}
		if window.GroupID != nil {
			if req.GroupID == "" || *window.GroupID != req.GroupID {
				respondError(w, http.StatusBadRequest, "maintenance window does not match selected group")
				return
			}
			if !s.canAccessGroup(claims, window.GroupID) {
				respondError(w, http.StatusForbidden, "maintenance window outside allowed scope")
				return
			}
		}
		maintenanceWindowID = req.MaintenanceWindowID
	}

	payloadBytes, _ := json.Marshal(req.Payload)
	id := uuid.New().String()

	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}

	var agentID, groupID interface{} = nil, nil
	if req.AgentID != "" {
		agentID = req.AgentID
	}
	if req.GroupID != "" {
		groupID = req.GroupID
	}

	timeout := req.Timeout
	if timeout == 0 {
		timeout = 1800
	}

	_, err := s.db.Pool.Exec(r.Context(), `
		INSERT INTO scheduled_commands
			(id, name, cron_expr, agent_id, group_id, maintenance_window_id, type, priority, payload, dry_run, timeout_seconds, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		id, req.Name, req.CronExpr, agentID, groupID,
		maintenanceWindowID, req.Type, req.Priority, payloadBytes, req.DryRun, timeout, createdBy)
	if err != nil {
		s.logger.Error("create scheduled command", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create scheduled command")
		return
	}

	respondOK(w, map[string]string{"id": id, "status": "created"})
}

func (s *Server) handleListCommands(w http.ResponseWriter, r *http.Request) {
	agentID := r.URL.Query().Get("agent_id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))

	cmds, err := s.db.ListCommands(r.Context(), agentID, limit)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list commands")
		return
	}
	if cmds == nil {
		cmds = []*db.DBCommand{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.DBCommand, 0, len(cmds))
		for _, cmd := range cmds {
			if cmd.AgentID != nil {
				agent, err := s.db.GetAgent(r.Context(), *cmd.AgentID)
				if err == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
					filtered = append(filtered, cmd)
				}
				continue
			}
			if cmd.GroupID != nil && s.canAccessGroup(s.getClaims(r.Context()), cmd.GroupID) {
				filtered = append(filtered, cmd)
			}
		}
		cmds = filtered
	}
	respondOK(w, cmds)
}

func (s *Server) handleListScheduledCommands(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListScheduledCommands(r.Context(), 100)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list scheduled commands")
		return
	}
	if items == nil {
		items = []*db.ScheduledCommand{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.ScheduledCommand, 0, len(items))
		for _, item := range items {
			if item.AgentID != nil {
				agent, err := s.db.GetAgent(r.Context(), *item.AgentID)
				if err == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
					filtered = append(filtered, item)
				}
				continue
			}
			if item.GroupID != nil && s.canAccessGroup(s.getClaims(r.Context()), item.GroupID) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	respondOK(w, items)
}

func (s *Server) handleCommandLog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cmd, err := s.db.GetCommand(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "command not found")
		return
	}
	if s.isScoped(s.getClaims(r.Context())) && !s.commandInScope(r, cmd) {
		respondError(w, http.StatusForbidden, "command outside allowed scope")
		return
	}
	respondOK(w, cmd)
}

func (s *Server) handleCancelCommand(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		cmd, err := s.db.GetCommand(r.Context(), id)
		if err != nil || !s.commandInScope(r, cmd) {
			respondError(w, http.StatusForbidden, "command outside allowed scope")
			return
		}
	}
	if err := s.db.CancelCommand(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to cancel command")
		return
	}
	respondOK(w, map[string]string{"status": "cancelled"})
}

func (s *Server) handleDeleteScheduledCommand(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		items, _ := s.db.ListScheduledCommands(r.Context(), 1000)
		allowed := false
		for _, item := range items {
			if item.ID == id && s.scheduledCommandInScope(r, item) {
				allowed = true
				break
			}
		}
		if !allowed {
			respondError(w, http.StatusForbidden, "scheduled command outside allowed scope")
			return
		}
	}
	if err := s.db.DeleteScheduledCommand(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete scheduled command")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) handleApproveCommand(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if s.isScoped(s.getClaims(r.Context())) {
		cmd, err := s.db.GetCommand(r.Context(), id)
		if err != nil || !s.commandInScope(r, cmd) {
			respondError(w, http.StatusForbidden, "command outside allowed scope")
			return
		}
	}

	user := getUserFromCtx(r.Context())
	var userID *string
	if user != nil {
		userID = &user.UserID
	}

	if err := s.db.SetCommandApproval(r.Context(), id, userID, req.Note); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to approve command")
		return
	}
	cmd, err := s.db.GetCommand(r.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "command not found")
		return
	}
	respondOK(w, cmd)
}

func (s *Server) handleListMaintenanceWindows(w http.ResponseWriter, r *http.Request) {
	items, err := s.db.ListMaintenanceWindows(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to list maintenance windows")
		return
	}
	if items == nil {
		items = []*db.MaintenanceWindow{}
	}
	if s.isScoped(s.getClaims(r.Context())) {
		filtered := make([]*db.MaintenanceWindow, 0, len(items))
		for _, item := range items {
			switch {
			case item.AgentID != nil:
				agent, err := s.db.GetAgent(r.Context(), *item.AgentID)
				if err == nil && s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
					filtered = append(filtered, item)
				}
			case item.GroupID != nil:
				if s.canAccessGroup(s.getClaims(r.Context()), item.GroupID) {
					filtered = append(filtered, item)
				}
			}
		}
		items = filtered
	}
	respondOK(w, items)
}

func (s *Server) handleCreateMaintenanceWindow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string  `json:"name"`
		AgentID    string  `json:"agent_id"`
		GroupID    string  `json:"group_id"`
		Timezone   string  `json:"timezone"`
		DaysOfWeek []int32 `json:"days_of_week"`
		StartTime  string  `json:"start_time"`
		EndTime    string  `json:"end_time"`
		Enabled    *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name == "" || req.StartTime == "" || req.EndTime == "" {
		respondError(w, http.StatusBadRequest, "name, start_time and end_time are required")
		return
	}
	if (req.AgentID == "" && req.GroupID == "") || (req.AgentID != "" && req.GroupID != "") {
		respondError(w, http.StatusBadRequest, "choose either server or group")
		return
	}
	if req.AgentID != "" {
		agent, err := s.db.GetAgent(r.Context(), req.AgentID)
		if err != nil {
			respondError(w, http.StatusNotFound, "server not found")
			return
		}
		if !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
			respondError(w, http.StatusForbidden, "server outside allowed scope")
			return
		}
	}
	if req.GroupID != "" && !s.canAccessGroup(s.getClaims(r.Context()), &req.GroupID) {
		respondError(w, http.StatusForbidden, "group outside allowed scope")
		return
	}
	if len(req.DaysOfWeek) == 0 {
		req.DaysOfWeek = []int32{1, 2, 3, 4, 5}
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	user := getUserFromCtx(r.Context())
	var createdBy *string
	if user != nil {
		createdBy = &user.UserID
	}
	var agentID *string
	var groupID *string
	if req.AgentID != "" {
		agentID = &req.AgentID
	}
	if req.GroupID != "" {
		groupID = &req.GroupID
	}
	item, err := s.db.CreateMaintenanceWindow(r.Context(), &db.MaintenanceWindow{
		Name:       req.Name,
		AgentID:    agentID,
		GroupID:    groupID,
		Timezone:   req.Timezone,
		DaysOfWeek: req.DaysOfWeek,
		StartTime:  req.StartTime,
		EndTime:    req.EndTime,
		Enabled:    enabled,
		CreatedBy:  createdBy,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create maintenance window")
		return
	}
	respondOK(w, item)
}

func (s *Server) handleDeleteMaintenanceWindow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.isScoped(s.getClaims(r.Context())) {
		item, err := s.db.GetMaintenanceWindow(r.Context(), id)
		if err != nil {
			respondError(w, http.StatusNotFound, "maintenance window not found")
			return
		}
		if item.AgentID != nil {
			agent, err := s.db.GetAgent(r.Context(), *item.AgentID)
			if err != nil || !s.canAccessGroup(s.getClaims(r.Context()), agent.GroupID) {
				respondError(w, http.StatusForbidden, "maintenance window outside allowed scope")
				return
			}
		}
		if item.GroupID != nil && !s.canAccessGroup(s.getClaims(r.Context()), item.GroupID) {
			respondError(w, http.StatusForbidden, "maintenance window outside allowed scope")
			return
		}
	}
	if err := s.db.DeleteMaintenanceWindow(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to delete maintenance window")
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}

func (s *Server) commandInScope(r *http.Request, cmd *db.DBCommand) bool {
	if cmd == nil {
		return false
	}
	claims := s.getClaims(r.Context())
	if cmd.AgentID != nil {
		agent, err := s.db.GetAgent(r.Context(), *cmd.AgentID)
		return err == nil && s.canAccessGroup(claims, agent.GroupID)
	}
	if cmd.GroupID != nil {
		return s.canAccessGroup(claims, cmd.GroupID)
	}
	return !s.isScoped(claims)
}

func (s *Server) scheduledCommandInScope(r *http.Request, item *db.ScheduledCommand) bool {
	if item == nil {
		return false
	}
	claims := s.getClaims(r.Context())
	if item.AgentID != nil {
		agent, err := s.db.GetAgent(r.Context(), *item.AgentID)
		return err == nil && s.canAccessGroup(claims, agent.GroupID)
	}
	if item.GroupID != nil {
		return s.canAccessGroup(claims, item.GroupID)
	}
	return !s.isScoped(claims)
}
