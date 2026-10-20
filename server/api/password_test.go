package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sms/server-mgmt/server/db"
)

type passwordStoreStub struct {
	reads, writes int
	user, expectedHash, password string
	inactive, ldap, wrongPassword bool
	readErr, hashErr, writeErr error
}

func (p *passwordStoreStub) GetUserByID(_ context.Context, id string) (*db.User, error) {
	p.reads++
	p.user = id
	source := "local"
	if p.ldap { source = "ldap" }
	return &db.User{ID: id, IsActive: !p.inactive, AuthSource: source}, p.readErr
}

func (p *passwordStoreStub) GetUserPasswordHash(_ context.Context, id string) (string, error) {
	p.user = id
	return "synthetic-expected-hash", p.hashErr
}

func (p *passwordStoreStub) VerifyPassword(hash, password string) bool {
	return !p.wrongPassword && hash == "synthetic-expected-hash" && password == " synthetic current "
}

func (p *passwordStoreStub) UpdateUserPassword(_ context.Context, id, hash, password string) error {
	p.writes++
	p.user, p.expectedHash, p.password = id, hash, password
	return p.writeErr
}

func TestPasswordChangeIsSelfScopedForEveryRole(t *testing.T) {
	for _, role := range []string{"admin", "operator", "readonly"} {
		store := &passwordStoreStub{}
		claims := &JWTClaims{UserID: "owner", SessionID: "current", Role: role}
		r := settingsRequest("POST", `{"current_password":" synthetic current ","new_password":" synthetic new "}`, claims)
		w := httptest.NewRecorder()
		(&Server{}).changePassword(w, r, store)
		if w.Code != 200 || store.writes != 1 || store.user != "owner" || store.expectedHash != "synthetic-expected-hash" || store.password != " synthetic new " {
			t.Fatalf("role=%s status=%d store=%+v", role, w.Code, store)
		}
		if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"status":"password_changed"`) {
			t.Fatal("missing confirmation or cache protection")
		}
	}
}

func TestPasswordChangeRejectsInvalidInputBeforeStorage(t *testing.T) {
	valid := `{"current_password":" synthetic current ","new_password":"synthetic-new"}`
	for _, body := range []string{
		`null`, `{}`, `[]`,
		`{"current_password":"","new_password":"synthetic-new"}`,
		`{"current_password":"x","new_password":"short"}`,
		`{"current_password":"x","new_password":"` + strings.Repeat("ą", 37) + `"}`,
		`{"current_password":"x","new_password":"synthetic-new","user_id":"victim"}`,
		valid + `{}`, valid + strings.Repeat(" ", 4096),
	} {
		store := &passwordStoreStub{}
		w := httptest.NewRecorder()
		(&Server{}).changePassword(w, settingsRequest("POST", body, &JWTClaims{UserID: "owner", SessionID: "current"}), store)
		if w.Code != 400 || store.reads != 0 || store.writes != 0 {
			t.Fatalf("invalid request reached storage: status=%d", w.Code)
		}
	}
	for _, claims := range []*JWTClaims{nil, {}, {UserID: "owner"}, {SessionID: "current"}} {
		store := &passwordStoreStub{}
		w := httptest.NewRecorder()
		(&Server{}).changePassword(w, settingsRequest("POST", valid, claims), store)
		if w.Code != 401 || store.reads != 0 || store.writes != 0 { t.Fatal("anonymous password change accepted") }
	}
}

func TestPasswordChangeFailsClosedAndDoesNotLeakSecrets(t *testing.T) {
	private := errors.New("private synthetic storage detail")
	for _, tc := range []struct {
		name string
		store passwordStoreStub
		status, writes int
	}{
		{"account read", passwordStoreStub{readErr: private}, 503, 0},
		{"hash read", passwordStoreStub{hashErr: private}, 503, 0},
		{"disabled", passwordStoreStub{inactive: true}, 401, 0},
		{"ldap", passwordStoreStub{ldap: true}, 400, 0},
		{"wrong password", passwordStoreStub{wrongPassword: true}, 400, 0},
		{"concurrent password or deactivation", passwordStoreStub{writeErr: db.ErrSessionInvalid}, 401, 1},
		{"write or audit or commit failure", passwordStoreStub{writeErr: private}, 503, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := settingsRequest("POST", `{"current_password":" synthetic current ","new_password":"synthetic-new"}`, &JWTClaims{UserID: "owner", SessionID: "current"})
			(&Server{}).changePassword(w, r, &tc.store)
			if w.Code != tc.status || tc.store.writes != tc.writes { t.Fatalf("status=%d writes=%d", w.Code, tc.store.writes) }
			for _, secret := range []string{"private", "synthetic current", "synthetic-new", "synthetic-expected-hash", "password_changed"} {
				if strings.Contains(w.Body.String(), secret) { t.Fatal("failure leaked a secret or claimed success") }
			}
		})
	}
}
