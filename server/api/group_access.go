package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/sms/server-mgmt/server/db"
)

type groupAccessStore interface {
	GetGroup(context.Context,string)(*db.Group,error)
	GetRequiredAgents(context.Context,string)([]string,error)
	SetRequiredAgents(context.Context,string,[]string)error
	DeleteGroup(context.Context,string)error
}

func (s *Server) handleGetRequiredAgents(w http.ResponseWriter,r *http.Request) { s.groupRequirements(w,r,s.db) }

func (s *Server) groupAccess(w http.ResponseWriter,r *http.Request,store groupAccessStore)(string,bool) {
	id,err:=uuid.Parse(chi.URLParam(r,"id"))
	if err!=nil { respondError(w,400,"invalid group id"); return "",false }
	value:=id.String()
	if !s.canAccessGroup(getUserFromCtx(r.Context()),&value) { respondError(w,404,"group not found in current scope"); return "",false }
	group,err:=store.GetGroup(r.Context(),value)
	if errors.Is(err,pgx.ErrNoRows) || (err==nil && group==nil) { respondError(w,404,"group not found in current scope"); return "",false }
	if err!=nil { respondError(w,503,"group unavailable"); return "",false }
	return value,true
}

func (s *Server) groupResource(w http.ResponseWriter,r *http.Request,store groupAccessStore) {
	s.requirePermission("groups.write")(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		id,ok:=s.groupAccess(w,r,store);if !ok{return}
		err:=store.DeleteGroup(r.Context(),id)
		if errors.Is(err,db.ErrGroupInUse){respondError(w,409,"group is in use; reassign servers and access scopes before deletion");return}
		if errors.Is(err,db.ErrScopedResourceMissing){respondError(w,404,"group not found in current scope");return}
		if err!=nil{respondError(w,503,"group deletion unavailable");return}
		respondOK(w,map[string]string{"status":"deleted"})
	})).ServeHTTP(w,r)
}

func (s *Server) groupRequirements(w http.ResponseWriter,r *http.Request,store groupAccessStore) {
	w.Header().Set("Cache-Control","no-store")
	permission:="groups.read";if r.Method==http.MethodPut{permission="groups.write"}
	s.requirePermission(permission)(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		id,ok:=s.groupAccess(w,r,store);if !ok{return}
		if r.Method==http.MethodGet{
			items,err:=store.GetRequiredAgents(r.Context(),id);if err!=nil{respondError(w,503,"requirements unavailable");return}
			if items==nil{items=[]string{}}
			respondOK(w,map[string]interface{}{"group_id":id,"agents":items});return
		}
		var req struct{Agents []string `json:"agents"`}
		r.Body=http.MaxBytesReader(w,r.Body,8192);decoder:=json.NewDecoder(r.Body);decoder.DisallowUnknownFields()
		if decoder.Decode(&req)!=nil || decoder.Decode(new(any))!=io.EOF || req.Agents==nil || len(req.Agents)>50{respondError(w,400,"provide up to 50 agent names");return}
		seen:=map[string]bool{};items:=[]string{}
		for _,name:=range req.Agents{
			name=strings.TrimSpace(name)
			if name=="" || !utf8.ValidString(name) || utf8.RuneCountInString(name)>100 || strings.IndexFunc(name,unicode.IsControl)>=0{respondError(w,400,"invalid agent name");return}
			if !seen[name]{items=append(items,name);seen[name]=true}
		}
		if err:=store.SetRequiredAgents(r.Context(),id,items);err!=nil{respondError(w,503,"requirements could not be saved");return}
		respondOK(w,map[string]interface{}{"group_id":id,"agents":items})
	})).ServeHTTP(w,r)
}

type reportAgentStore interface{GetAgent(context.Context,string)(*db.Agent,error)}

func(s *Server) authorizedReportAgent(ctx context.Context,id string,store reportAgentStore)(*db.Agent,error){
	agent,err:=store.GetAgent(ctx,id)
	if err!=nil{return nil,err}
	if getUserFromCtx(ctx)==nil || agent==nil || !s.canAccessGroup(getUserFromCtx(ctx),agent.GroupID){return nil,db.ErrScopedResourceMissing}
	return agent,nil
}
