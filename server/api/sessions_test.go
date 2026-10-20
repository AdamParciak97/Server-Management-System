package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/sms/server-mgmt/server/db"
)

type accountStoreStub struct {
	err, rotateErr, permissionErr, scopeErr error
	user, session string
	reads, rotations, writes, checks int
	others, inactive bool
}
func (s *accountStoreStub) ValidateAccountSession(_ context.Context,u,id string) error { s.checks++;s.user=u;s.session=id;return s.err }
func (s *accountStoreStub) ListAccountSessions(_ context.Context,u string) ([]*db.AccountSession,error) {
	s.reads++;s.user=u
	return []*db.AccountSession{{ID:"current",UserID:u,UserAgent:"synthetic browser"},{ID:"other"}},s.err
}
func (s *accountStoreStub) RevokeAccountSessions(_ context.Context,u,id string,others bool) (int64,error) {s.writes++;s.user=u;s.session=id;s.others=others;return 2,s.err}
func (s *accountStoreStub) GetRefreshSession(context.Context,string) (*db.AccountSession,error) {s.reads++;return &db.AccountSession{ID:"current",UserID:"owner"},s.err}
func (s *accountStoreStub) GetUserByID(context.Context,string) (*db.User,error) {return &db.User{ID:"owner",IsActive:!s.inactive,Role:"readonly"},nil}
func (s *accountStoreStub) ListUserPermissions(context.Context,string) ([]string,error) {return nil,s.permissionErr}
func (s *accountStoreStub) ListUserGroupScopes(context.Context,string) ([]string,error) {return []string{"synthetic-group"},s.scopeErr}
func (s *accountStoreStub) RotateAccountSession(_ context.Context,u,id,oldHash,newHash string) error {
	s.rotations++;s.user=u;s.session=id
	if len(oldHash)!=64 || len(newHash)!=64 || oldHash==newHash {return errors.New("invalid token hashes")}
	return s.rotateErr
}

func TestSessionEndpointsAreAlwaysSelfScoped(t *testing.T) {
	for _,role:=range []string{"admin","operator","readonly"} {
		claims:=&JWTClaims{UserID:"owner",SessionID:"current",Role:role}
		store:=&accountStoreStub{};s:=&Server{}
		r:=settingsRequest("GET",`{"user_id":"victim"}`,claims);w:=httptest.NewRecorder()
		s.listSessions(w,r,store)
		if w.Code!=200 || store.user!="owner" {t.Fatalf("list role=%s status=%d",role,w.Code)}
		if strings.Contains(w.Body.String(),"user_id") || strings.Contains(w.Body.String(),"token") {t.Fatal("private fields in listing")}
		if !strings.Contains(w.Body.String(),`"current":true`) || w.Header().Get("Cache-Control")!="no-store" {t.Fatal("missing current session/cache protection")}
		for _,others:=range []bool{false,true} {
			w=httptest.NewRecorder();s.revokeSessions(w,settingsRequest("POST",`{"user_id":"victim","session_id":"victim-session"}`,claims),store,others)
			if w.Code!=200 || store.user!="owner" || store.session!="current" || store.others!=others {t.Fatal("request body changed revocation scope")}
		}
	}
}

func TestAnonymousSessionEndpointsDoNotReachStorage(t *testing.T) {
	for _,claims:=range []*JWTClaims{nil,{}, {UserID:"owner"}} {
		store:=&accountStoreStub{};s:=&Server{}
		w:=httptest.NewRecorder();s.listSessions(w,settingsRequest("GET","",claims),store)
		if w.Code!=401 || store.reads!=0 {t.Fatal("anonymous list accepted")}
		w=httptest.NewRecorder();s.revokeSessions(w,settingsRequest("POST","",claims),store,true)
		if w.Code!=401 || store.writes!=0 {t.Fatal("anonymous write accepted")}
	}
}

func TestSessionStorageFailureNeverReturnsSuccess(t *testing.T) {
	for _,failure:=range []error{db.ErrSessionInvalid,errors.New("synthetic private storage error")} {
		want:=503;if errors.Is(failure,db.ErrSessionInvalid){want=401}
		store:=&accountStoreStub{err:failure};s:=&Server{};claims:=&JWTClaims{UserID:"owner",SessionID:"current"}
		for _,write:=range []bool{false,true} {
			w:=httptest.NewRecorder();r:=settingsRequest("POST","",claims)
			if write{s.revokeSessions(w,r,store,true)}else{s.listSessions(w,r,store)}
			if w.Code!=want || strings.Contains(w.Body.String(),"private") {t.Fatal("unsafe session error")}
		}
	}
}

func TestRefreshCommitsBeforePublishingCredentials(t *testing.T) {
	for _,tc:=range []struct{name string;store accountStoreStub;status,rotations int}{
		{"success",accountStoreStub{},200,1},
		{"used",accountStoreStub{err:db.ErrSessionInvalid},401,0},
		{"read failure",accountStoreStub{err:errors.New("private")},503,0},
		{"disabled",accountStoreStub{inactive:true},401,0},
		{"permission failure",accountStoreStub{permissionErr:errors.New("private")},503,0},
		{"scope failure",accountStoreStub{scopeErr:errors.New("private")},503,0},
		{"race lost",accountStoreStub{rotateErr:db.ErrSessionInvalid},401,1},
		{"write or commit failure",accountStoreStub{rotateErr:errors.New("private")},503,1},
	} {
		t.Run(tc.name,func(t *testing.T){
			s:=&Server{jwtSecret:[]byte("synthetic-test-signing-key")};w:=httptest.NewRecorder()
			s.refreshSession(w,settingsRequest("POST",`{"refresh_token":"synthetic-old"}`,nil),&tc.store)
			if w.Code!=tc.status || tc.store.rotations!=tc.rotations {t.Fatalf("status %d rotations %d",w.Code,tc.store.rotations)}
			if tc.status!=200 && (strings.Contains(w.Body.String(),"access_token") || strings.Contains(w.Body.String(),"private")) {t.Fatal("error leaked credentials/details")}
			if tc.status==200 {
				var body struct{Data struct{Access string `json:"access_token"`;Refresh string `json:"refresh_token"`} `json:"data"`}
				if err:=json.Unmarshal(w.Body.Bytes(),&body);err!=nil{t.Fatal(err)}
				claims:=&JWTClaims{}
				_,err:=jwt.ParseWithClaims(body.Data.Access,claims,func(*jwt.Token)(interface{},error){return s.jwtSecret,nil})
				if err!=nil || claims.SessionID!="current" || len(body.Data.Refresh)!=64 || len(claims.GroupScopes)!=1 {t.Fatal("invalid issued credentials")}
			}
		})
	}
}

func TestRefreshRejectsMalformedOrOversizedInput(t *testing.T) {
	for _,body:=range []string{`null`,`{}`,`[]`,`{"refresh_token":"x","user_id":"victim"}`,`{"refresh_token":"x"} {}`,`{"refresh_token":"`+strings.Repeat("x",257)+`"}`,strings.Repeat(" ",4097)+`{}`} {
		store:=&accountStoreStub{};w:=httptest.NewRecorder()
		(&Server{}).refreshSession(w,settingsRequest("POST",body,nil),store)
		if w.Code!=400 || store.reads!=0 {t.Fatal("invalid input reached storage")}
	}
}

func TestAccessChecksLiveSessionAndFailsClosed(t *testing.T) {
	for _,tc:=range []struct{name string;err error;session string;expiry bool;method jwt.SigningMethod;status int}{
		{"active",nil,"current",true,jwt.SigningMethodHS256,204},
		{"revoked or disabled",db.ErrSessionInvalid,"current",true,jwt.SigningMethodHS256,401},
		{"storage outage",errors.New("private"),"current",true,jwt.SigningMethodHS256,503},
		{"legacy",nil,"",true,jwt.SigningMethodHS256,401},
		{"missing expiry",nil,"current",false,jwt.SigningMethodHS256,401},
		{"wrong algorithm",nil,"current",true,jwt.SigningMethodHS512,401},
	} {
		t.Run(tc.name,func(t *testing.T){
			s:=&Server{jwtSecret:[]byte("synthetic-test-key")};store:=&accountStoreStub{err:tc.err}
			claims:=&JWTClaims{UserID:"owner",SessionID:tc.session}
			if tc.expiry{claims.ExpiresAt=jwt.NewNumericDate(time.Now().Add(time.Minute))}
			token,err:=jwt.NewWithClaims(tc.method,claims).SignedString(s.jwtSecret);if err!=nil{t.Fatal(err)}
			r:=httptest.NewRequest("GET","/api/account/sessions",nil);r.Header.Set("Authorization","Bearer "+token)
			w:=httptest.NewRecorder();s.sessionMiddleware(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)}),store).ServeHTTP(w,r)
			if w.Code!=tc.status{t.Fatalf("status=%d",w.Code)}
			if tc.status==204 && (store.user!="owner" || store.session!="current") {t.Fatal("wrong session checked")}
		})
	}
}

func TestLiveAuthorizationReplacesOldAdminAndRejectsScopeFailures(t *testing.T) {
	for _,failure:=range []string{"","permission","scope"} {
		s:=&Server{jwtSecret:[]byte("synthetic-test-key")};store:=&accountStoreStub{}
		if failure=="permission" {store.permissionErr=errors.New("synthetic")}
		if failure=="scope" {store.scopeErr=errors.New("synthetic")}
		claims:=&JWTClaims{UserID:"owner",SessionID:"current",Role:"admin",Permissions:[]string{"users.write"}}
		claims.ExpiresAt=jwt.NewNumericDate(time.Now().Add(time.Minute))
		token,err:=jwt.NewWithClaims(jwt.SigningMethodHS256,claims).SignedString(s.jwtSecret);if err!=nil{t.Fatal(err)}
		r:=httptest.NewRequest("GET","/api/account/sessions",nil);r.Header.Set("Authorization","Bearer "+token)
		called:=false;w:=httptest.NewRecorder()
		s.sessionMiddleware(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
			called=true;actual:=getUserFromCtx(r.Context())
			if actual.Role!="readonly" || len(actual.GroupScopes)!=1 || actual.GroupScopes[0]!="synthetic-group" {t.Fatal("stale authorization retained")}
			for _,p:=range actual.Permissions {if p=="users.write"{t.Fatal("removed permission retained")}}
			w.WriteHeader(204)
		}),store).ServeHTTP(w,r)
		if failure=="" && (!called || w.Code!=204) {t.Fatal("live authorization failed")}
		if failure!="" && (called || w.Code!=503) {t.Fatal("authorization lookup failed open")}
	}
}

type failingLDAPMappingStore struct{}
func (failingLDAPMappingStore) ListLDAPGroupMappings(context.Context) ([]*db.LDAPGroupMapping,error) {return nil,errors.New("synthetic database outage")}
func TestLDAPMappingFailureDoesNotBecomeUnscopedLogin(t *testing.T) {
	role,scopes,err:=storedLDAPAccess(context.Background(),[]string{"synthetic-group"},"operator",failingLDAPMappingStore{})
	if err==nil || role!="" || scopes!=nil {t.Fatal("mapping lookup failed open")}
}
