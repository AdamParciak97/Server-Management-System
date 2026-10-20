package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
)

type scopedMutationStore interface {
	AcknowledgeAlertScoped(context.Context, string, string, []string) error
	DeleteCompliancePolicyScoped(context.Context, string, []string) error
	DeleteComplianceExceptionScoped(context.Context, string, []string) error
}

func (s *Server) scopedMutation(w http.ResponseWriter, r *http.Request, store scopedMutationStore, kind string) {
	permission := "compliance.write"
	if kind == "alert" { permission = "alerts.ack" }
	s.requirePermission(permission)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := getUserFromCtx(r.Context())
		if claims == nil || claims.UserID == "" { respondError(w,401,"unauthenticated"); return }
		id, err := uuid.Parse(chi.URLParam(r,"id"))
		if err != nil { respondError(w,400,"invalid resource id"); return }
		var scopes []string
		if s.isScoped(claims) { scopes = claims.GroupScopes }
		status := "deleted"
		switch kind {
		case "alert": err = store.AcknowledgeAlertScoped(r.Context(),id.String(),claims.UserID,scopes); status = "acknowledged"
		case "policy": err = store.DeleteCompliancePolicyScoped(r.Context(),id.String(),scopes)
		case "exception": err = store.DeleteComplianceExceptionScoped(r.Context(),id.String(),scopes)
		default: respondError(w,400,"invalid operation"); return
		}
		if errors.Is(err,db.ErrScopedResourceMissing) { respondError(w,404,"resource not found in current scope"); return }
		if err != nil { respondError(w,503,"operation unavailable; retry later"); return }
		respondOK(w,map[string]string{"status":status})
	})).ServeHTTP(w,r)
}
