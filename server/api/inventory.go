package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/sms/server-mgmt/server/db"
)

type inventoryStore interface {
	ListInventory(context.Context,db.InventoryFilter,int,[]string)(*db.InventoryPage,error)
	ListInventoryViews(context.Context,string)([]db.InventoryView,error)
	SaveInventoryView(context.Context,string,string,string,db.InventoryFilter)(*db.InventoryView,error)
	DeleteInventoryView(context.Context,string,string)error
}

func (s *Server) handleInventory(w http.ResponseWriter,r *http.Request){s.inventory(w,r,s.db)}
func (s *Server) handleInventoryViews(w http.ResponseWriter,r *http.Request){s.inventoryViews(w,r,s.db)}

func (s *Server) handleInventoryGroups(w http.ResponseWriter,r *http.Request){
	w.Header().Set("Cache-Control","no-store")
	groups,err:=s.db.ListGroups(r.Context());if err!=nil{respondError(w,503,"inventory groups unavailable");return}
	items:=make([]map[string]string,0,len(groups))
	for _,group:=range s.filterGroupsByScope(getUserFromCtx(r.Context()),groups){items=append(items,map[string]string{"id":group.ID,"name":group.Name})}
	respondOK(w,items)
}

func (s *Server) inventory(w http.ResponseWriter,r *http.Request,store inventoryStore){
	w.Header().Set("Cache-Control","no-store")
	s.requirePermission("servers.read")(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		claims:=getUserFromCtx(r.Context());if claims==nil || claims.UserID==""{respondError(w,401,"unauthenticated");return}
		q,parseErr:=url.ParseQuery(r.URL.RawQuery);if parseErr!=nil{respondError(w,400,"invalid query");return}
		for key,values:=range q{if len(values)!=1 || (key!="search" && key!="status" && key!="group" && key!="os" && key!="sort" && key!="page" && key!="page_size"){respondError(w,400,"invalid query parameter");return}}
		page,size:=1,25;var err error
		if q.Has("page"){page,err=strconv.Atoi(q.Get("page"));if err!=nil || page<1 || page>1000000{respondError(w,400,"invalid page");return}}
		if q.Has("page_size"){size,err=strconv.Atoi(q.Get("page_size"));if err!=nil || size<1 || size>100{respondError(w,400,"invalid page_size");return}}
		f:=db.InventoryFilter{Search:q.Get("search"),Status:q.Get("status"),Group:q.Get("group"),OS:q.Get("os"),Sort:q.Get("sort"),PageSize:size}
		if err=f.Validate();err!=nil{respondError(w,400,err.Error());return}
		var scopes []string;if s.isScoped(claims){scopes=claims.GroupScopes}
		if !s.inventoryGroupAllowed(claims,f.Group){respondError(w,403,"group outside current scope");return}
		result,err:=store.ListInventory(r.Context(),f,page,scopes);if err!=nil{respondError(w,503,"inventory unavailable; retry later");return};respondOK(w,result)
	})).ServeHTTP(w,r)
}

func(s *Server) inventoryGroupAllowed(claims *JWTClaims,group string)bool{
	if group==""{return true};if group=="__ungrouped__"{return !s.isScoped(claims)};return s.canAccessGroup(claims,&group)
}

func(s *Server) inventoryViews(w http.ResponseWriter,r *http.Request,store inventoryStore){
	w.Header().Set("Cache-Control","no-store")
	// Personal preferences may be saved by readonly accounts with inventory access.
	s.requirePermission("servers.read")(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		claims:=getUserFromCtx(r.Context());if claims==nil || claims.UserID==""{respondError(w,401,"unauthenticated");return}
		if r.Method==http.MethodGet{items,err:=store.ListInventoryViews(r.Context(),claims.UserID);if err!=nil{inventoryFailure(w,err);return};respondOK(w,items);return}
		id:=chi.URLParam(r,"viewID")
		if r.Method==http.MethodPut || r.Method==http.MethodDelete{parsed,err:=uuid.Parse(id);if err!=nil{respondError(w,400,"invalid view id");return};id=parsed.String()}
		if r.Method==http.MethodDelete{if err:=store.DeleteInventoryView(r.Context(),claims.UserID,id);err!=nil{inventoryFailure(w,err);return};respondOK(w,map[string]bool{"deleted":true});return}
		r.Body=http.MaxBytesReader(w,r.Body,4096);decoder:=json.NewDecoder(r.Body);decoder.DisallowUnknownFields()
		var req struct{Name string `json:"name"`;Filters db.InventoryFilter `json:"filters"`}
		if err:=decoder.Decode(&req);err!=nil{respondError(w,400,"invalid saved view");return};if decoder.Decode(new(any))!=io.EOF{respondError(w,400,"invalid saved view");return}
		if strings.IndexFunc(req.Name,unicode.IsControl)>=0{respondError(w,400,"invalid name");return}
		req.Name=strings.TrimSpace(req.Name)
		if !utf8.ValidString(req.Name) || len(req.Name)==0 || utf8.RuneCountInString(req.Name)>80 || strings.IndexFunc(req.Name,unicode.IsControl)>=0{respondError(w,400,"name must contain 1–80 characters without control characters");return}
		if err:=req.Filters.Validate();err!=nil{respondError(w,400,err.Error());return}
		if !s.inventoryGroupAllowed(claims,req.Filters.Group){respondError(w,403,"group outside current scope");return}
		v,err:=store.SaveInventoryView(r.Context(),claims.UserID,id,req.Name,req.Filters);if err!=nil{inventoryFailure(w,err);return};respondOK(w,v)
	})).ServeHTTP(w,r)
}

func inventoryFailure(w http.ResponseWriter,err error){
	if errors.Is(err,db.ErrInventoryViewMissing){respondError(w,404,"saved view not found");return}
	if errors.Is(err,db.ErrInventoryViewLimit){respondError(w,409,err.Error());return}
	respondError(w,503,"saved views unavailable; retry later")
}
