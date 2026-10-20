package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sms/server-mgmt/server/db"
)

type inventoryStub struct {
	user,id,name string
	filters db.InventoryFilter
	page,calls int
	scopes []string
	err error
}
func (i *inventoryStub) ListInventory(_ context.Context,f db.InventoryFilter,page int,scopes []string)(*db.InventoryPage,error){i.calls++;i.filters=f;i.page=page;i.scopes=scopes;return &db.InventoryPage{Items:[]*db.Agent{},Page:page,PageSize:f.PageSize},i.err}
func (i *inventoryStub) ListInventoryViews(_ context.Context,user string)([]db.InventoryView,error){i.calls++;i.user=user;return []db.InventoryView{},i.err}
func (i *inventoryStub) SaveInventoryView(_ context.Context,user,id,name string,f db.InventoryFilter)(*db.InventoryView,error){i.calls++;i.user=user;i.id=id;i.name=name;i.filters=f;return &db.InventoryView{ID:"saved",Name:name,Filters:f},i.err}
func (i *inventoryStub) DeleteInventoryView(_ context.Context,user,id string)error{i.calls++;i.user=user;i.id=id;return i.err}

const inventoryGroup = "10000000-0000-0000-0000-000000000001"
const inventoryOther = "10000000-0000-0000-0000-000000000002"

func TestInventoryPermissionAndScope(t *testing.T){
	s:=&Server{}
	for _,tc:=range []struct{name string;claims *JWTClaims;query string;status int}{
		{"anonymous",nil,"",401},
		{"no permission",&JWTClaims{UserID:"owner",Role:"operator"},"",403},
		{"admin",&JWTClaims{UserID:"owner",Role:"admin",GroupScopes:[]string{inventoryGroup}},"",200},
		{"readonly scoped",&JWTClaims{UserID:"owner",Role:"readonly",Permissions:[]string{"servers.read"},GroupScopes:[]string{inventoryGroup}},"?page=2&page_size=50&sort=seen",200},
		{"foreign group",&JWTClaims{UserID:"owner",Role:"operator",Permissions:[]string{"servers.read"},GroupScopes:[]string{inventoryGroup}},"?group="+inventoryOther,403},
		{"ungrouped denied",&JWTClaims{UserID:"owner",Role:"readonly",Permissions:[]string{"servers.read"},GroupScopes:[]string{inventoryGroup}},"?group=__ungrouped__",403},
	}{t.Run(tc.name,func(t *testing.T){
		r:=httptest.NewRequest("GET","/api/inventory/servers"+tc.query,nil)
		if tc.claims!=nil{r=r.WithContext(context.WithValue(r.Context(),ctxUser,tc.claims))}
		w:=httptest.NewRecorder();store:=&inventoryStub{};s.inventory(w,r,store)
		if w.Code!=tc.status{t.Fatalf("status %d: %s",w.Code,w.Body.String())}
		if tc.status!=200 && store.calls!=0{t.Fatal("unauthorized database access")}
		if tc.name=="readonly scoped" && (len(store.scopes)!=1 || store.scopes[0]!=inventoryGroup || store.page!=2 || store.filters.PageSize!=50 || store.filters.Sort!="seen"){t.Fatal("scope/pagination lost")}
		if tc.name=="admin" && store.scopes!=nil{t.Fatal("admin unexpectedly scoped")}
	})}
}

func TestInventoryRejectsInvalidQueriesBeforeStorage(t *testing.T){
	for _,query:=range []string{"page=0","page=-1","page=1000001","page=no","page_size=0","page_size=101","page_size=99999999999999999999","page=1&page=2","sort=hostname;DROP","status=bad","os=mac","group=no","owner=other","search="+strings.Repeat("a",201),"search=%00"}{
		t.Run(query,func(t *testing.T){
			r:=httptest.NewRequest("GET","/api/inventory/servers?"+query,nil);r=r.WithContext(context.WithValue(r.Context(),ctxUser,&JWTClaims{UserID:"owner",Role:"admin"}))
			w:=httptest.NewRecorder();store:=&inventoryStub{};(&Server{}).inventory(w,r,store)
			if w.Code!=400 || store.calls!=0{t.Fatalf("bad input accepted: %d",w.Code)}
		})
	}
}

func TestInventoryViewsOwnerValidationAndErrors(t *testing.T){
	valid:=`{"name":"  My fleet  ","filters":{"search":" host ","sort":"seen","page_size":50}}`
	for _,role:=range []string{"admin","operator","readonly"}{
		for _,method:=range []string{"GET","POST","PUT","DELETE"}{t.Run(role+method,func(t *testing.T){
			store:=&inventoryStub{};r:=httptest.NewRequest(method,"/api/inventory/views",strings.NewReader(valid))
			ctx:=chi.NewRouteContext();ctx.URLParams.Add("viewID",inventoryOther)
			r=r.WithContext(context.WithValue(context.WithValue(r.Context(),ctxUser,&JWTClaims{UserID:"authenticated-owner",Role:role,Permissions:[]string{"servers.read"}}),chi.RouteCtxKey,ctx))
			w:=httptest.NewRecorder();(&Server{}).inventoryViews(w,r,store)
			if w.Code!=200 || store.user!="authenticated-owner"{t.Fatalf("owner lost: %d %s",w.Code,w.Body.String())}
			if method=="POST" || method=="PUT"{if store.name!="My fleet" || store.filters.Search!="host" || store.filters.PageSize!=50{t.Fatal("filters lost")}}
			if method=="PUT" || method=="DELETE"{if store.id!=inventoryOther{t.Fatal("id lost")}}
		})}
	}
	for _,body:=range []string{`{}`,`null`,`{"name":"   "}`,`{"name":"x","user_id":"victim"}`,`{"name":"x","filters":{"scope":["other"]}}`,`{"name":"x","filters":{"group":"`+inventoryOther+`"}}`,`{"name":"x"} {}`,`{"name":"x","filters":{"page_size":101}}`,`{"name":"`+strings.Repeat("x",81)+`"}`,`{"name":"x\n"}`,strings.Repeat(" ",4097)+valid}{
		r:=httptest.NewRequest("POST","/api/inventory/views",strings.NewReader(body));r=r.WithContext(context.WithValue(r.Context(),ctxUser,&JWTClaims{UserID:"owner",Role:"readonly",Permissions:[]string{"servers.read"},GroupScopes:[]string{inventoryGroup}}))
		w:=httptest.NewRecorder();store:=&inventoryStub{};(&Server{}).inventoryViews(w,r,store)
		if w.Code<400 || store.calls!=0{t.Fatalf("invalid body persisted: %s",body)}
	}
	for _,tc:=range []struct{err error;status int}{{db.ErrInventoryViewMissing,404},{db.ErrInventoryViewLimit,409},{errors.New("synthetic database detail"),503}}{
		w:=httptest.NewRecorder();inventoryFailure(w,tc.err)
		if w.Code!=tc.status || strings.Contains(w.Body.String(),"synthetic database detail"){t.Fatal("unsafe error response")}
	}
}

func TestInventoryViewsRejectMissingPermission(t *testing.T){
	for _,method:=range []string{"GET","POST","PUT","DELETE"}{for _,authenticated:=range []bool{false,true}{
		r:=httptest.NewRequest(method,"/api/inventory/views",strings.NewReader(`{"name":"x"}`))
		status:=401;if authenticated{status=403;r=r.WithContext(context.WithValue(r.Context(),ctxUser,&JWTClaims{UserID:"owner",Role:"readonly"}))}
		w:=httptest.NewRecorder();store:=&inventoryStub{};(&Server{}).inventoryViews(w,r,store)
		if w.Code!=status || store.calls!=0{t.Fatal("unauthorized view access")}
	}}
}
