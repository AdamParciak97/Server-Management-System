package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sms/server-mgmt/server/db"
)

type tokenStoreStub struct {
	tokens []*db.RegToken
	reads, creates, revokes int
	expiry *time.Time
	err error
}
func (s *tokenStoreStub) ListRegistrationTokens(context.Context) ([]*db.RegToken, error) { s.reads++; return s.tokens, s.err }
func (s *tokenStoreStub) CreateRegistrationToken(_ context.Context, _ db.TokenActor, expiry *time.Time, _ string) (*db.RegToken, error) { s.creates++; s.expiry=expiry; return &db.RegToken{Token:"synthetic-once"},s.err }
func (s *tokenStoreStub) RevokeRegistrationToken(context.Context, string, db.TokenActor) error { s.revokes++;return s.err }

func TestTokenPermissions(t *testing.T) {
	for _, tc := range []struct{ name string; claims *JWTClaims; read, write int }{
		{"anonymous",nil,401,401},
		{"readonly",&JWTClaims{Role:"readonly"},403,403},
		{"reader",&JWTClaims{Permissions:[]string{"tokens.read"}},200,403},
		{"writer",&JWTClaims{Permissions:[]string{"tokens.write"}},403,200},
		{"admin",&JWTClaims{Role:"admin"},200,200},
	} {
		t.Run(tc.name,func(t *testing.T){
			s:=&Server{};store:=&tokenStoreStub{};w:=httptest.NewRecorder()
			s.listTokens(w,settingsRequest(http.MethodGet,"",tc.claims),store)
			if w.Code!=tc.read || (store.reads>0)!=(tc.read==200) {t.Fatalf("read: %d, calls=%d",w.Code,store.reads)}
			w=httptest.NewRecorder();s.createToken(w,settingsRequest(http.MethodPost,`{}`,tc.claims),store)
			if w.Code!=tc.write || (store.creates>0)!=(tc.write==200) {t.Fatalf("create: %d, calls=%d",w.Code,store.creates)}
			r:=settingsRequest(http.MethodPost,"",tc.claims);route:=chi.NewRouteContext();route.URLParams.Add("id","00000000-0000-0000-0000-000000000001");r=r.WithContext(context.WithValue(r.Context(),chi.RouteCtxKey,route))
			w=httptest.NewRecorder();s.revokeToken(w,r,store)
			if w.Code!=tc.write || (store.revokes>0)!=(tc.write==200) {t.Fatalf("revoke: %d, calls=%d",w.Code,store.revokes)}
		})
	}
}

func TestTokenListNeverExposesSecret(t *testing.T) {
	store:=&tokenStoreStub{tokens:[]*db.RegToken{{ID:"test-id",Token:"synthetic-private"}}}
	w:=httptest.NewRecorder();(&Server{}).listTokens(w,settingsRequest(http.MethodGet,"",&JWTClaims{Role:"admin"}),store)
	if w.Code!=200 || strings.Contains(w.Body.String(),"synthetic-private") || strings.Contains(w.Body.String(),`"token":`) {t.Fatalf("unsafe response: %s",w.Body.String())}
	if store.tokens[0].Token!="synthetic-private" {t.Fatal("response redaction mutated stored token")}
	if w.Header().Get("Cache-Control")!="no-store" {t.Fatal("missing cache protection")}
}

func TestTokenCreationValidationAndDefaultExpiry(t *testing.T) {
	for _, body:=range []string{`null`,`[]`,`{} {}`,`{"unknown":true}`,`{"expires_at":"2000-01-01T00:00:00Z"}`,`{"expires_at":"2099-01-01T00:00:00Z"}`,`{"note":"`+strings.Repeat("x",201)+`"}`,strings.Repeat(" ",4097)+`{}`} {
		store:=&tokenStoreStub{};w:=httptest.NewRecorder();(&Server{}).createToken(w,settingsRequest(http.MethodPost,body,&JWTClaims{Role:"admin"}),store)
		if w.Code!=400 || store.creates!=0 {t.Fatalf("invalid request accepted: status=%d calls=%d",w.Code,store.creates)}
	}
	store:=&tokenStoreStub{};w:=httptest.NewRecorder();before:=time.Now();(&Server{}).createToken(w,settingsRequest(http.MethodPost,`{}`,&JWTClaims{Role:"admin"}),store)
	if w.Code!=200 || store.expiry==nil || store.expiry.Before(before.Add(23*time.Hour)) || store.expiry.After(before.Add(25*time.Hour)) {t.Fatal("invalid default expiry")}
}

func TestUnavailableRevocationAndStorageErrors(t *testing.T) {
	for _, tc:=range []struct{err error;status int}{{db.ErrRegistrationTokenUnavailable,409},{errors.New("synthetic-private-database-error"),500}} {
		r:=settingsRequest(http.MethodPost,"",&JWTClaims{Role:"admin"});route:=chi.NewRouteContext();route.URLParams.Add("id","00000000-0000-0000-0000-000000000001");r=r.WithContext(context.WithValue(r.Context(),chi.RouteCtxKey,route))
		w:=httptest.NewRecorder();(&Server{}).revokeToken(w,r,&tokenStoreStub{err:tc.err})
		if w.Code!=tc.status || strings.Contains(w.Body.String(),"synthetic-private") {t.Fatalf("unsafe error: %d %s",w.Code,w.Body.String())}
	}
}
