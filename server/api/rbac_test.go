package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/sms/server-mgmt/server/db"
)

const scopeA = "10000000-0000-0000-0000-000000000001"
const scopeB = "10000000-0000-0000-0000-000000000002"
const scopedUser = "10000000-0000-0000-0000-000000000003"

func rbacRequest(method, id, body string, claims *JWTClaims) *http.Request {
	r := settingsRequest(method, body, claims)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route))
}

func roleClaims(role string, scopes []string, extra ...string) *JWTClaims {
	return &JWTClaims{UserID: scopedUser, Role: role, GroupScopes: scopes, Permissions: db.BuildEffectivePermissions(role, extra)}
}

func TestRBACPermissionMatrix(t *testing.T) {
	for _, role := range []string{"admin", "operator", "readonly", "custom"} {
		for _, permission := range db.AllPermissions() {
			t.Run(role+"/"+permission, func(t *testing.T) {
				claims := roleClaims(role, nil)
				// Independent expected contract, not the production defaults under test.
				expected := map[string]string{
					"operator": " servers.read servers.write commands.read commands.write commands.approve alerts.read alerts.ack packages.read packages.write compliance.read compliance.write groups.read groups.write stats.read settings.read ",
					"readonly": " servers.read commands.read alerts.read packages.read compliance.read groups.read stats.read settings.read ",
				}
				want := role == "admin" || strings.Contains(expected[role], " "+permission+" ")
				called := false
				h := (&Server{}).requirePermission(permission)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
				w := httptest.NewRecorder()
				h.ServeHTTP(w, settingsRequest("GET", "", claims))
				if called != want || (!want && w.Code != 403) { t.Fatalf("called=%v status=%d wantAllowed=%v", called, w.Code, want) }
				// An explicit custom grant works without granting an unrelated permission.
				claims = roleClaims("custom", nil, permission)
				called = false
				h.ServeHTTP(httptest.NewRecorder(), settingsRequest("GET", "", claims))
				if !called { t.Fatal("custom permission ignored") }
			})
		}
	}
}

type groupAccessStub struct {
	reads, writes, deletes int
	items []string
	lookupErr, writeErr error
}

func (g *groupAccessStub) GetGroup(_ context.Context, id string) (*db.Group, error) {
	g.reads++
	return &db.Group{ID: id}, g.lookupErr
}
func (g *groupAccessStub) GetRequiredAgents(context.Context, string) ([]string, error) { return g.items, g.writeErr }
func (g *groupAccessStub) SetRequiredAgents(_ context.Context, _ string, items []string) error {
	g.writes++
	g.items = items
	return g.writeErr
}
func (g *groupAccessStub) DeleteGroup(context.Context, string) error { g.deletes++; return g.writeErr }

func TestGroupRequirementsAndDeletionMatrix(t *testing.T) {
	for _, tc := range []struct {
		name string
		claims *JWTClaims
		id string
		read, write int
	}{
		{"anonymous", nil, scopeA, 401, 401},
		{"admin", roleClaims("admin", []string{scopeB}), scopeA, 200, 200},
		{"operator-own", roleClaims("operator", []string{scopeA}), scopeA, 200, 200},
		{"operator-other", roleClaims("operator", []string{scopeA}), scopeB, 404, 404},
		{"readonly-own", roleClaims("readonly", []string{scopeA}), scopeA, 200, 403},
		{"readonly-other", roleClaims("readonly", []string{scopeA}), scopeB, 404, 403},
		{"custom-writer", roleClaims("custom", []string{scopeA}, "groups.write"), scopeA, 403, 200},
		{"custom-reader", roleClaims("custom", []string{scopeA}, "groups.read"), scopeA, 200, 403},
		{"global-operator", roleClaims("operator", nil), scopeB, 200, 200},
	} {
		for _, method := range []string{"GET", "PUT", "DELETE"} {
			t.Run(tc.name+"/"+method, func(t *testing.T) {
				store := &groupAccessStub{}
				w := httptest.NewRecorder()
				r := rbacRequest(method, tc.id, `{"agents":["Custom sensor"]}`, tc.claims)
				want := tc.write
				if method == "GET" { want = tc.read }
				if method == "DELETE" { (&Server{}).groupResource(w, r, store) } else { (&Server{}).groupRequirements(w, r, store) }
				if w.Code != want { t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String()) }
				if want != 200 && (store.reads != 0 || store.writes != 0 || store.deletes != 0) { t.Fatal("denied request accessed store") }
			})
		}
	}
}

func TestGroupRequirementsValidationAndRoundtrip(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"agents":null}`, `{"agents":[],"unknown":true}`, `{"agents":[]} {}`, `{"agents":[""]}`, `{"agents":["x\u0000y"]}`, `{"agents":["`+strings.Repeat("x", 101)+`"]}`, `{"agents":[`+strings.Repeat(`"x",`, 50)+`"y"]}`, strings.Repeat(" ", 8193)+`{"agents":[]}`} {
		store := &groupAccessStub{}
		w := httptest.NewRecorder()
		(&Server{}).groupRequirements(w, rbacRequest("PUT", scopeA, body, roleClaims("admin", nil)), store)
		if w.Code != 400 || store.writes != 0 { t.Fatalf("invalid body accepted: %d", w.Code) }
	}
	store := &groupAccessStub{}
	w := httptest.NewRecorder()
	(&Server{}).groupRequirements(w, rbacRequest("PUT", scopeA, `{"agents":[" Custom sensor ","Custom sensor","Drugi agent"]}`, roleClaims("operator", []string{scopeA})), store)
	if w.Code != 200 || !reflect.DeepEqual(store.items, []string{"Custom sensor", "Drugi agent"}) { t.Fatalf("bad persisted set: %d %v", w.Code, store.items) }
	w = httptest.NewRecorder()
	(&Server{}).groupRequirements(w, rbacRequest("GET", scopeA, "", roleClaims("readonly", []string{scopeA})), store)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Custom sensor") || w.Header().Get("Cache-Control") != "no-store" { t.Fatal("readback failed") }
	w = httptest.NewRecorder()
	(&Server{}).groupRequirements(w, rbacRequest("PUT", scopeA, `{"agents":[]}`, roleClaims("admin", nil)), store)
	if w.Code != 200 || len(store.items) != 0 { t.Fatal("explicit clear failed") }
}

func TestGroupFailuresDoNotReportSuccess(t *testing.T) {
	for _, tc := range []struct { lookup, write error; status int }{
		{pgx.ErrNoRows, nil, 404}, {errors.New("synthetic-private"), nil, 503},
		{nil, db.ErrGroupInUse, 409}, {nil, db.ErrScopedResourceMissing, 404}, {nil, errors.New("synthetic-private"), 503},
	} {
		w := httptest.NewRecorder()
		(&Server{}).groupResource(w, rbacRequest("DELETE", scopeA, "", roleClaims("admin", nil)), &groupAccessStub{lookupErr: tc.lookup, writeErr: tc.write})
		if w.Code != tc.status || strings.Contains(w.Body.String(), "synthetic-private") { t.Fatalf("unsafe failure: %d %s", w.Code, w.Body.String()) }
	}
	for _, body := range []string{`{"name":" "}`, `{"name":"x","unknown":true}`, `{"name":"x"} {}`, `{"name":"x\u0000"}`, `{"name":"`+strings.Repeat("x",101)+`"}`} {
		w := httptest.NewRecorder()
		(&Server{}).handleCreateGroup(w, settingsRequest("POST", body, roleClaims("admin", nil)))
		if w.Code != 400 { t.Fatalf("invalid group status=%d",w.Code) }
	}
	w := httptest.NewRecorder()
	(&Server{}).handleCreateGroup(w, settingsRequest("POST", `{"name":"new"}`, roleClaims("operator", []string{scopeA})))
	if w.Code != 403 { t.Fatal("scoped creation reached database") }
}

type mutationStub struct { calls int; scopes []string; actor string; err error }
func (m *mutationStub) AcknowledgeAlertScoped(_ context.Context, _, user string, scopes []string) error { m.calls++; m.scopes=scopes; m.actor=user; return m.err }
func (m *mutationStub) DeleteCompliancePolicyScoped(_ context.Context, _ string, scopes []string) error { m.calls++; m.scopes=scopes; return m.err }
func (m *mutationStub) DeleteComplianceExceptionScoped(_ context.Context, _ string, scopes []string) error { m.calls++; m.scopes=scopes; return m.err }

func TestScopedMutationsRequirePermissionAndPassScopeToWrite(t *testing.T) {
	for _, kind := range []string{"alert", "policy", "exception"} {
		for _, role := range []string{"admin", "operator", "readonly", "custom"} {
			t.Run(kind+"/"+role, func(t *testing.T) {
				store := &mutationStub{}
				w := httptest.NewRecorder()
				(&Server{}).scopedMutation(w, rbacRequest("POST", scopeB, "", roleClaims(role, []string{scopeA})), store, kind)
				if role == "readonly" || role == "custom" {
					if w.Code != 403 || store.calls != 0 { t.Fatal("write without permission") }; return
				}
				if w.Code != 200 || store.calls != 1 { t.Fatal("write missing") }
				if role == "admin" && store.scopes != nil { t.Fatal("admin unexpectedly restricted") }
				if role == "operator" && !reflect.DeepEqual(store.scopes, []string{scopeA}) { t.Fatal("scope lost before SQL") }
				if kind == "alert" && store.actor != scopedUser { t.Fatal("actor not taken from session") }
			})
		}
		for _, tc := range []struct { err error; status int }{{db.ErrScopedResourceMissing,404}, {errors.New("synthetic-private"),503}} {
			w := httptest.NewRecorder()
			(&Server{}).scopedMutation(w, rbacRequest("POST", scopeB, "", roleClaims("operator", []string{scopeA})), &mutationStub{err:tc.err}, kind)
			if w.Code != tc.status || strings.Contains(w.Body.String(),"synthetic-private") { t.Fatal("unsafe mutation failure") }
		}
	}
}

type reportScopeStub struct { group *string; err error }
func (s reportScopeStub) GetAgent(context.Context, string) (*db.Agent,error) { return &db.Agent{ID: scopeB,GroupID:s.group},s.err }

func TestReportServerAndCommandScopeBoundaries(t *testing.T) {
	a,b := scopeA,scopeB
	for _, claims := range []*JWTClaims{nil,roleClaims("admin",[]string{scopeA}),roleClaims("operator",[]string{scopeA}),roleClaims("readonly",[]string{scopeA}),roleClaims("custom",[]string{scopeA},"servers.read")} {
		for _, group := range []*string{&a,&b,nil} {
			ctx := context.Background()
			if claims != nil { ctx=context.WithValue(ctx,ctxUser,claims) }
			want := claims != nil && (claims.Role == "admin" || group != nil && *group == scopeA)
			_,err := (&Server{}).authorizedReportAgent(ctx,scopeB,reportScopeStub{group:group})
			if (err==nil)!=want { t.Fatalf("report scope allowed=%v want=%v",err==nil,want) }
			if (&Server{}).canAccessGroup(claims,group)!=want { t.Fatal("server/target group scope differs") }
			if group != nil && claims != nil {
				r := settingsRequest("GET","",claims)
				if (&Server{}).commandInScope(r,&db.DBCommand{GroupID:group})!=want { t.Fatal("command group scope differs") }
				if (&Server{}).scheduledCommandInScope(r,&db.ScheduledCommand{GroupID:group})!=want { t.Fatal("schedule group scope differs") }
			}
		}
	}
	_,err:=(&Server{}).authorizedReportAgent(context.WithValue(context.Background(),ctxUser,roleClaims("admin",nil)),scopeA,reportScopeStub{err:errors.New("offline")})
	if err==nil { t.Fatal("lookup failure authorized report") }
}
