package db

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Explicit opt-in, loopback and a dedicated database name are mandatory. Never
// use the application's DSN. Each test creates its own synthetic schema.
func sessionPostgres(t *testing.T) (*DB,string) {
	t.Helper()
	dsn:=os.Getenv("SMS_TEST_POSTGRES_DSN")
	if dsn=="" {t.Skip("set SMS_TEST_POSTGRES_DSN to an isolated loopback sms_test_* database")}
	cfg,err:=pgxpool.ParseConfig(dsn);if err!=nil{t.Fatal("invalid test DSN")}
	if (cfg.ConnConfig.Host!="127.0.0.1" && cfg.ConnConfig.Host!="::1" && cfg.ConnConfig.Host!="localhost") || !strings.HasPrefix(cfg.ConnConfig.Database,"sms_test_") {t.Fatal("refusing non-local/non-test PostgreSQL")}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		if fallback.Host != "127.0.0.1" && fallback.Host != "::1" && fallback.Host != "localhost" {
			t.Fatal("refusing non-local PostgreSQL fallback")
		}
	}
	ctx:=context.Background()
	admin,err:=pgxpool.NewWithConfig(ctx,cfg);if err!=nil{t.Fatal(err)}
	t.Cleanup(admin.Close)
	schema:="session_test_"+strings.ReplaceAll(uuid.New().String(),"-","")
	if _,err=admin.Exec(ctx,`CREATE SCHEMA `+schema);err!=nil{t.Fatal(err)}
	t.Cleanup(func(){if _,err:=admin.Exec(ctx,`DROP SCHEMA `+schema+` CASCADE`);err!=nil{t.Error(err)}})
	cfg.ConnConfig.RuntimeParams["search_path"]=schema
	cfg.ConnConfig.RuntimeParams["statement_timeout"]="10000"
	cfg.MaxConns=8
	pool,err:=pgxpool.NewWithConfig(ctx,cfg);if err!=nil{t.Fatal(err)}
	t.Cleanup(pool.Close)
	d:=&DB{Pool:pool}
	_,err=pool.Exec(ctx,`CREATE TABLE users (id UUID PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT DEFAULT 'readonly',auth_source TEXT DEFAULT 'local',is_active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT NOW(),last_login TIMESTAMPTZ);
		CREATE TABLE refresh_tokens (id UUID PRIMARY KEY,user_id UUID REFERENCES users(id),token_hash TEXT,expires_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),revoked BOOLEAN DEFAULT false);
		CREATE TABLE audit_log (user_id UUID,username TEXT,action TEXT,result TEXT);`)
	if err!=nil{t.Fatal(err)}
	user:=uuid.New().String()
	if _,err=pool.Exec(ctx,`INSERT INTO users(id,username,email,password_hash) VALUES ($1,'synthetic','synthetic@example.test','synthetic-hash')`,user);err!=nil{t.Fatal(err)}
	if _,err=pool.Exec(ctx,`INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES ($1,$2,'legacy',NOW()+INTERVAL '1 day')`,uuid.New().String(),user);err!=nil{t.Fatal(err)}
	migration,err:=os.ReadFile("../migrations/011_account_sessions.up.sql");if err!=nil{t.Fatal(err)}
	if _,err=pool.Exec(ctx,string(migration));err!=nil{t.Fatal(err)}
	var revoked bool
	if err=pool.QueryRow(ctx,`SELECT revoked FROM refresh_tokens WHERE token_hash='legacy'`).Scan(&revoked);err!=nil || !revoked{t.Fatal("legacy credential not preserved and revoked",err)}
	return d,user
}

func seedAccountSession(t *testing.T,d *DB,user,hash string) string {
	t.Helper();id:=uuid.New().String()
	if err:=d.CreateAccountSession(context.Background(),user,"synthetic-hash",id,hash,"Synthetic browser",time.Now().Add(time.Hour));err!=nil{t.Fatal(err)}
	return id
}

func TestPostgresSessionRotationHasExactlyOneWinner(t *testing.T) {
	d,user:=sessionPostgres(t);ctx:=context.Background()
	id:=seedAccountSession(t,d,user,"old")
	start:=make(chan struct{});results:=make(chan error,8);var wg sync.WaitGroup
	for i:=0;i<8;i++ {wg.Add(1);go func(){defer wg.Done();<-start;results<-d.RotateAccountSession(ctx,user,id,"old",uuid.New().String())}()}
	close(start);wg.Wait();close(results)
	winners:=0
	for err:=range results {if err==nil{winners++}else if !errors.Is(err,ErrSessionInvalid){t.Fatal(err)}}
	if winners!=1{t.Fatalf("winners=%d",winners)}
	var active int
	if err:=d.Pool.QueryRow(ctx,`SELECT count(*) FROM refresh_tokens WHERE session_id=$1 AND NOT revoked`,id).Scan(&active);err!=nil || active!=1{t.Fatal("invalid token count",active,err)}
	if _,err:=d.GetRefreshSession(ctx,"old");!errors.Is(err,ErrSessionInvalid){t.Fatal("replay accepted",err)}
}

func TestPostgresSessionFailuresRollback(t *testing.T) {
	d,user:=sessionPostgres(t);ctx:=context.Background();id:=seedAccountSession(t,d,user,"old")
	_,err:=d.Pool.Exec(ctx,`CREATE FUNCTION reject_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.token_hash='fail' THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_refresh BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_refresh();`)
	if err!=nil{t.Fatal(err)}
	if err=d.RotateAccountSession(ctx,user,id,"old","fail");err==nil{t.Fatal("failed replacement accepted")}
	if _,err=d.GetRefreshSession(ctx,"old");err!=nil{t.Fatal("old token lost on failed write",err)}
	_,err=d.Pool.Exec(ctx,`CREATE FUNCTION reject_refresh_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.token_hash='commit-fail' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END $$;
		CREATE CONSTRAINT TRIGGER reject_refresh_commit AFTER INSERT ON refresh_tokens DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_refresh_commit();`)
	if err!=nil{t.Fatal(err)}
	if err=d.RotateAccountSession(ctx,user,id,"old","commit-fail");err==nil{t.Fatal("failed commit accepted")}
	if _,err=d.GetRefreshSession(ctx,"old");err!=nil{t.Fatal("old token lost on failed commit",err)}
	newID:=uuid.New().String()
	if err=d.CreateAccountSession(ctx,user,"synthetic-hash",newID,"fail","test",time.Now().Add(time.Hour));err==nil{t.Fatal("failed login accepted")}
	var count int
	if err=d.Pool.QueryRow(ctx,`SELECT count(*) FROM account_sessions WHERE id=$1`,newID).Scan(&count);err!=nil || count!=0{t.Fatal("partial login persisted")}
	other:=seedAccountSession(t,d,user,"other")
	_,err=d.Pool.Exec(ctx,`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
		CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit();`)
	if err!=nil{t.Fatal(err)}
	if _,err=d.RevokeAccountSessions(ctx,user,id,true);err==nil{t.Fatal("audit failure accepted")}
	if err=d.ValidateAccountSession(ctx,user,other);err!=nil{t.Fatal("partial revocation persisted")}
	if err=d.UpdateUserPassword(ctx,user,"synthetic-hash","synthetic-new-password");err==nil{t.Fatal("password audit failure accepted")}
	hash,err:=d.GetUserPasswordHash(ctx,user);if err!=nil || hash!="synthetic-hash"{t.Fatal("partial password update persisted")}
}

func TestPostgresSessionScopeRevocationAndExpiry(t *testing.T) {
	d,user:=sessionPostgres(t);ctx:=context.Background()
	current:=seedAccountSession(t,d,user,"current");other:=seedAccountSession(t,d,user,"other")
	victim:=uuid.New().String()
	if _,err:=d.Pool.Exec(ctx,`INSERT INTO users(id,username,password_hash) VALUES ($1,'victim','synthetic-hash')`,victim);err!=nil{t.Fatal(err)}
	victimSession:=seedAccountSession(t,d,victim,"victim")
	if err:=d.ValidateAccountSession(ctx,user,victimSession);!errors.Is(err,ErrSessionInvalid){t.Fatal("foreign session accepted")}
	if _,err:=d.RevokeAccountSessions(ctx,user,victimSession,true);!errors.Is(err,ErrSessionInvalid){t.Fatal("foreign session used as current")}
	n,err:=d.RevokeAccountSessions(ctx,user,current,true);if err!=nil || n!=1{t.Fatal("wrong revocation count",n,err)}
	if err=d.ValidateAccountSession(ctx,user,current);err!=nil{t.Fatal("current revoked")}
	if err=d.ValidateAccountSession(ctx,victim,victimSession);err!=nil{t.Fatal("foreign user affected")}
	if err=d.ValidateAccountSession(ctx,user,other);!errors.Is(err,ErrSessionInvalid){t.Fatal("other still valid")}
	if err=d.RotateAccountSession(ctx,user,other,"other","revived");!errors.Is(err,ErrSessionInvalid){t.Fatal("revoked session revived")}
	if _,err=d.Pool.Exec(ctx,`UPDATE account_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,current);err!=nil{t.Fatal(err)}
	if err=d.ValidateAccountSession(ctx,user,current);!errors.Is(err,ErrSessionInvalid){t.Fatal("expired access accepted")}
	if _,err=d.GetRefreshSession(ctx,"current");!errors.Is(err,ErrSessionInvalid){t.Fatal("expired refresh accepted")}
}

func TestPostgresPasswordAndDeactivationWinConcurrentRefresh(t *testing.T) {
	for _,action:=range []string{"password","disable","revoke"} {t.Run(action,func(t *testing.T){
		d,user:=sessionPostgres(t);ctx:=context.Background();current:=seedAccountSession(t,d,user,"current");id:=seedAccountSession(t,d,user,"old")
		start:=make(chan struct{});done:=make(chan error,1)
		go func(){<-start;done<-d.RotateAccountSession(ctx,user,id,"old","new")}()
		close(start)
		var err error
		switch action {case "password":err=d.UpdateUserPassword(ctx,user,"synthetic-hash","synthetic-new-password");case "disable":err=d.DeleteUser(ctx,user);case "revoke":_,err=d.RevokeAccountSessions(ctx,user,current,true)}
		if err!=nil{t.Fatal(err)}
		if err=<-done;err!=nil && !errors.Is(err,ErrSessionInvalid){t.Fatal(err)}
		if err=d.ValidateAccountSession(ctx,user,id);!errors.Is(err,ErrSessionInvalid){t.Fatal("old access survived")}
		for _,hash:=range []string{"old","new"}{if _,err=d.GetRefreshSession(ctx,hash);!errors.Is(err,ErrSessionInvalid){t.Fatal("refresh survived",hash)}}
		if action=="password" {
			if err=d.CreateAccountSession(ctx,user,"synthetic-hash",uuid.New().String(),"stale-login","",time.Now().Add(time.Hour));!errors.Is(err,ErrSessionInvalid){t.Fatal("old password login survived")}
			newHash, err := d.GetUserPasswordHash(ctx, user)
			if err != nil || !d.VerifyPassword(newHash, "synthetic-new-password") { t.Fatal("new password not persisted", err) }
			if err = d.CreateAccountSession(ctx, user, newHash, uuid.New().String(), "new-login", "Synthetic browser", time.Now().Add(time.Hour)); err != nil { t.Fatal("new password login rejected", err) }
		}
		if action=="disable" {
			if _,err=d.Pool.Exec(ctx,`UPDATE users SET auth_source='ldap' WHERE id=$1`,user);err!=nil{t.Fatal(err)}
			if _,err=d.CreateOrUpdateLDAPUser(ctx,"synthetic","synthetic@example.test","readonly");err==nil{t.Fatal("LDAP reactivated disabled account")}
		}
	})}
}

func TestPostgresStalePasswordChangeDoesNotRevokeSessions(t *testing.T) {
	d, user := sessionPostgres(t)
	ctx := context.Background()
	id := seedAccountSession(t, d, user, "current")
	if err := d.UpdateUserPassword(ctx, user, "stale-expected-hash", "synthetic-new-password"); !errors.Is(err, ErrSessionInvalid) {
		t.Fatal("stale password accepted", err)
	}
	hash, err := d.GetUserPasswordHash(ctx, user)
	if err != nil || hash != "synthetic-hash" { t.Fatal("rejected password update changed the account", err) }
	if err = d.ValidateAccountSession(ctx, user, id); err != nil { t.Fatal("rejected change revoked access", err) }
	if _, err = d.GetRefreshSession(ctx, "current"); err != nil { t.Fatal("rejected change revoked refresh", err) }
	var count int
	if err = d.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action='account.password.change'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("rejected password change wrote a success audit", err)
	}
}
