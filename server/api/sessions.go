package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/sms/server-mgmt/server/db"
)

type sessionValidator interface {
	authorizationStore
	ValidateAccountSession(context.Context,string,string) error
	GetUserByID(context.Context,string) (*db.User,error)
}
type sessionStore interface {
	ListAccountSessions(context.Context,string) ([]*db.AccountSession,error)
	RevokeAccountSessions(context.Context,string,string,bool) (int64,error)
}
type authorizationStore interface {
	ListUserPermissions(context.Context,string) ([]string,error)
	ListUserGroupScopes(context.Context,string) ([]string,error)
}
type refreshSessionStore interface {
	authorizationStore
	GetRefreshSession(context.Context,string) (*db.AccountSession,error)
	GetUserByID(context.Context,string) (*db.User,error)
	RotateAccountSession(context.Context,string,string,string,string) error
}

func sessionFailure(w http.ResponseWriter, err error) {
	if errors.Is(err,db.ErrSessionInvalid) { respondError(w,401,"session expired or revoked"); return }
	respondError(w,503,"session storage unavailable; retry later")
}

func (s *Server) handleListSessions(w http.ResponseWriter,r *http.Request) { s.listSessions(w,r,s.db) }
func (s *Server) handleRevokeOtherSessions(w http.ResponseWriter,r *http.Request) { s.revokeSessions(w,r,s.db,true) }

func (s *Server) listSessions(w http.ResponseWriter,r *http.Request,store sessionStore) {
	w.Header().Set("Cache-Control","no-store")
	claims:=getUserFromCtx(r.Context())
	if claims==nil || claims.UserID=="" || claims.SessionID=="" { respondError(w,401,"unauthenticated"); return }
	items,err:=store.ListAccountSessions(r.Context(),claims.UserID)
	if err!=nil { sessionFailure(w,err);return }
	if items==nil { items=[]*db.AccountSession{} }
	for _,item:=range items { item.Current=item.ID==claims.SessionID }
	respondOK(w,items)
}

func (s *Server) revokeSessions(w http.ResponseWriter,r *http.Request,store sessionStore,others bool) {
	w.Header().Set("Cache-Control","no-store")
	claims:=getUserFromCtx(r.Context())
	if claims==nil || claims.UserID=="" || claims.SessionID=="" { respondError(w,401,"unauthenticated"); return }
	count,err:=store.RevokeAccountSessions(r.Context(),claims.UserID,claims.SessionID,others)
	if err!=nil { sessionFailure(w,err);return }
	respondOK(w,map[string]interface{}{"revoked":count})
}
