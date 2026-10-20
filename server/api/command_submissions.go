package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

type commandSubmissionStore interface {
	SubmitCommands(context.Context,string,string,string,string,shared.Command,[]string)(*db.CommandReceipt,error)
}

func (s *Server) submitCommands(w http.ResponseWriter,r *http.Request,store commandSubmissionStore) {
	w.Header().Set("Cache-Control","no-store")
	s.requirePermission("commands.write")(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		claims:=getUserFromCtx(r.Context())
		if claims==nil || uuid.Validate(claims.UserID)!=nil {respondError(w,401,"unauthenticated");return}
		var req *struct {
			AgentID string `json:"agent_id"`
			GroupID string `json:"group_id"`
			Type shared.CommandType `json:"type"`
			Priority shared.CommandPriority `json:"priority"`
			DryRun bool `json:"dry_run"`
			Timeout int `json:"timeout_seconds"`
			Payload shared.CommandPayload `json:"payload"`
		}
		r.Body=http.MaxBytesReader(w,r.Body,128<<10)
		decoder:=json.NewDecoder(r.Body);decoder.DisallowUnknownFields()
		if err:=decoder.Decode(&req);err!=nil || req==nil {respondError(w,400,"invalid command request (maximum 128 KiB)");return}
		if decoder.Decode(new(any))!=io.EOF {respondError(w,400,"invalid command request");return}
		if (req.AgentID=="")== (req.GroupID=="") {respondError(w,400,"choose exactly one target: agent_id or group_id");return}
		for _,id:=range []*string{&req.AgentID,&req.GroupID} {
			if *id!="" {parsed,err:=uuid.Parse(*id);if err!=nil{respondError(w,400,"invalid target id");return};*id=parsed.String()}
		}
		if req.GroupID!="" && !s.canAccessGroup(claims,&req.GroupID) {respondError(w,404,"target not found in current scope");return}
		if req.Priority=="" {req.Priority=shared.PriorityNormal}
		switch req.Priority {case shared.PriorityLow,shared.PriorityNormal,shared.PriorityHigh,shared.PriorityCritical:
		default:respondError(w,400,"invalid priority");return}
		if req.Timeout==0 {req.Timeout=1800}
		if req.Timeout<30 || req.Timeout>86400 {respondError(w,400,"timeout must be between 30 and 86400 seconds");return}
		switch req.Type {
		case shared.CmdSystemUpdate,shared.CmdInstallAgent,shared.CmdForceReport:
		case shared.CmdInstallPackage:
			if strings.TrimSpace(req.Payload.PackageName)=="" {respondError(w,400,"package name required");return}
		case shared.CmdRunScript:
			if strings.TrimSpace(req.Payload.ScriptContent)=="" || (req.Payload.ScriptType!="bash" && req.Payload.ScriptType!="powershell") {respondError(w,400,"script content and supported script type required");return}
		case shared.CmdServiceControl:
			if strings.TrimSpace(req.Payload.ServiceName)=="" || (req.Payload.ServiceAction!="start" && req.Payload.ServiceAction!="stop" && req.Payload.ServiceAction!="restart") {respondError(w,400,"service name and supported action required");return}
		default:respondError(w,400,"unsupported command type");return
		}
		key:=r.Header.Get("Idempotency-Key")
		if len(r.Header.Values("Idempotency-Key"))>1 {respondError(w,400,"Idempotency-Key must be one UUID");return}
		if key=="" {key=uuid.New().String()} else {
			id,err:=uuid.Parse(key);if err!=nil || len(r.Header.Values("Idempotency-Key"))!=1{respondError(w,400,"Idempotency-Key must be one UUID");return};key=id.String()
		}
		var scopes []string;if s.isScoped(claims){scopes=claims.GroupScopes}
		cmd:=shared.Command{Type:req.Type,Priority:req.Priority,DryRun:req.DryRun,Timeout:req.Timeout,Payload:req.Payload}
		receipt,err:=store.SubmitCommands(r.Context(),claims.UserID,key,req.AgentID,req.GroupID,cmd,scopes)
		switch {
		case errors.Is(err,db.ErrCommandSubmissionConflict):respondError(w,409,"request key already used; retry the original unchanged command");return
		case errors.Is(err,db.ErrScopedResourceMissing):respondError(w,404,"target or receipt not found in current scope");return
		case errors.Is(err,db.ErrCommandTargetLimit):respondError(w,422,"group exceeds 1000 targets; no commands created");return
		case err!=nil:respondError(w,503,"submission could not be confirmed; retry with the same key and unchanged command");return
		}
		respondOK(w,receipt)
	})).ServeHTTP(w,r)
}
