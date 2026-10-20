package db

import (
	"context"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func rbacPostgres(t *testing.T) (*DB,string,string,string,string,string) {
	t.Helper()
	d,user:=sessionPostgres(t)
	ctx:=context.Background()
	_,err:=d.Pool.Exec(ctx,`CREATE TABLE groups(id UUID PRIMARY KEY,name TEXT,description TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
		CREATE TABLE agents(id UUID PRIMARY KEY,group_id UUID REFERENCES groups(id));
		CREATE TABLE alerts(id UUID PRIMARY KEY,agent_id UUID REFERENCES agents(id),acknowledged BOOLEAN DEFAULT false,acknowledged_by UUID,acknowledged_at TIMESTAMPTZ);
		CREATE TABLE compliance_policies(id UUID PRIMARY KEY,group_id UUID REFERENCES groups(id));
		CREATE TABLE compliance_exceptions(id UUID PRIMARY KEY,agent_id UUID REFERENCES agents(id));
		CREATE TABLE required_security_agents(id UUID PRIMARY KEY,group_id UUID REFERENCES groups(id) ON DELETE CASCADE,agent_name TEXT NOT NULL,UNIQUE(group_id,agent_name));
		CREATE TABLE user_group_scopes(user_id UUID REFERENCES users(id),group_id UUID REFERENCES groups(id) ON DELETE CASCADE);
		CREATE TABLE ldap_group_mappings(id UUID PRIMARY KEY,group_id UUID REFERENCES groups(id) ON DELETE CASCADE);`)
	if err!=nil {t.Fatal(err)}
	a,b,hostA,hostB:=uuid.NewString(),uuid.NewString(),uuid.NewString(),uuid.NewString()
	if _,err=d.Pool.Exec(ctx,`INSERT INTO groups(id,name) VALUES($1,'Synthetic A'),($2,'Synthetic B')`,a,b);err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(ctx,`INSERT INTO agents(id,group_id) VALUES($1,$2),($3,$4)`,hostA,a,hostB,b);err!=nil{t.Fatal(err)}
	return d,user,a,b,hostA,hostB
}

func TestPostgresScopedMutationsEnforceOwnershipInsideSQL(t *testing.T) {
	d,user,a,b,hostA,hostB:=rbacPostgres(t)
	ctx:=context.Background()
	for _,tc:=range []struct{name string;scopes []string;group,host *string;allowed bool}{
		{"own",[]string{a},&a,&hostA,true},
		{"foreign",[]string{a},&b,&hostB,false},
		{"global-resource",[]string{a},nil,nil,false},
		{"empty-denies",[]string{},&a,&hostA,false},
		{"global-user",nil,&b,&hostB,true},
	} {
		t.Run(tc.name,func(t *testing.T){
			id:=uuid.NewString()
			if _,err:=d.Pool.Exec(ctx,`INSERT INTO alerts(id,agent_id) VALUES($1,$2)`,id,tc.host);err!=nil{t.Fatal(err)}
			if _,err:=d.Pool.Exec(ctx,`INSERT INTO compliance_policies(id,group_id) VALUES($1,$2)`,id,tc.group);err!=nil{t.Fatal(err)}
			if _,err:=d.Pool.Exec(ctx,`INSERT INTO compliance_exceptions(id,agent_id) VALUES($1,$2)`,id,tc.host);err!=nil{t.Fatal(err)}
			for _,write:=range []func()error{
				func()error{return d.AcknowledgeAlertScoped(ctx,id,user,tc.scopes)},
				func()error{return d.DeleteCompliancePolicyScoped(ctx,id,tc.scopes)},
				func()error{return d.DeleteComplianceExceptionScoped(ctx,id,tc.scopes)},
			} {
				if err:=write();(err==nil)!=tc.allowed || (!tc.allowed && !errors.Is(err,ErrScopedResourceMissing)){t.Fatalf("unexpected scoped result %v",err)}
			}
			var ack bool;var actor *string;var policies,exceptions int
			if err:=d.Pool.QueryRow(ctx,`SELECT acknowledged,acknowledged_by FROM alerts WHERE id=$1`,id).Scan(&ack,&actor);err!=nil{t.Fatal(err)}
			if err:=d.Pool.QueryRow(ctx,`SELECT COUNT(*) FROM compliance_policies WHERE id=$1`,id).Scan(&policies);err!=nil{t.Fatal(err)}
			if err:=d.Pool.QueryRow(ctx,`SELECT COUNT(*) FROM compliance_exceptions WHERE id=$1`,id).Scan(&exceptions);err!=nil{t.Fatal(err)}
			if ack!=tc.allowed || (policies==0)!=tc.allowed || (exceptions==0)!=tc.allowed {t.Fatal("database state does not match authorization")}
			if tc.allowed && (actor==nil || *actor!=user) {t.Fatal("actor missing")}
			if !tc.allowed && actor!=nil {t.Fatal("denied write changed actor")}
		})
	}
	if err:=d.AcknowledgeAlertScoped(ctx,uuid.NewString(),user,nil);!errors.Is(err,ErrScopedResourceMissing){t.Fatal("missing alert did not return not found")}
}

func TestPostgresGroupDeletionCannotEraseLastAccessScope(t *testing.T) {
	d,user,_,_,_,_:=rbacPostgres(t)
	ctx:=context.Background()
	group,ldapGroup:=uuid.NewString(),uuid.NewString()
	if _,err:=d.Pool.Exec(ctx,`INSERT INTO groups(id,name) VALUES($1,'User scope'),($2,'LDAP scope')`,group,ldapGroup);err!=nil{t.Fatal(err)}
	if _,err:=d.Pool.Exec(ctx,`INSERT INTO user_group_scopes(user_id,group_id) VALUES($1,$2)`,user,group);err!=nil{t.Fatal(err)}
	if _,err:=d.Pool.Exec(ctx,`INSERT INTO ldap_group_mappings(id,group_id) VALUES($1,$2)`,uuid.NewString(),ldapGroup);err!=nil{t.Fatal(err)}
	migration,err:=os.ReadFile("../migrations/013_preserve_group_scopes.up.sql");if err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(ctx,string(migration));err!=nil{t.Fatal(err)}
	for _,id:=range []string{group,ldapGroup} {
		if err=d.DeleteGroup(ctx,id);!errors.Is(err,ErrGroupInUse){t.Fatalf("referenced group deletion not blocked: %v",err)}
		if _,err=d.GetGroup(ctx,id);err!=nil{t.Fatal("group lost after failed deletion")}
	}
	var n int
	if err=d.Pool.QueryRow(ctx,`SELECT COUNT(*) FROM user_group_scopes WHERE user_id=$1 AND group_id=$2`,user,group).Scan(&n);err!=nil || n!=1{t.Fatal("last account scope lost",err)}
	if err=d.Pool.QueryRow(ctx,`SELECT COUNT(*) FROM ldap_group_mappings WHERE group_id=$1`,ldapGroup).Scan(&n);err!=nil || n!=1{t.Fatal("directory scope lost",err)}
	down,err:=os.ReadFile("../migrations/013_preserve_group_scopes.down.sql");if err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(ctx,string(down));err!=nil{t.Fatal(err)}
	for _,id:=range []string{group,ldapGroup}{if err=d.DeleteGroup(ctx,id);!errors.Is(err,ErrGroupInUse){t.Fatal("rollback removed scope protection",err)}}
	free:=uuid.NewString()
	if _,err=d.Pool.Exec(ctx,`INSERT INTO groups(id,name) VALUES($1,'Unused synthetic')`,free);err!=nil{t.Fatal(err)}
	if err=d.DeleteGroup(ctx,free);err!=nil{t.Fatal(err)}
	if err=d.DeleteGroup(ctx,free);!errors.Is(err,ErrScopedResourceMissing){t.Fatal("missing group deletion reports success")}
}

func TestPostgresRequirementReplacementIsAtomicAndSerialized(t *testing.T) {
	d,_,group,_,_,_:=rbacPostgres(t)
	ctx:=context.Background()
	if err:=d.SetRequiredAgents(ctx,group,[]string{"Original custom sensor"});err!=nil{t.Fatal(err)}
	if err:=d.SetRequiredAgents(ctx,group,[]string{"Duplicate","Duplicate"});err==nil{t.Fatal("expected fixture constraint failure")}
	items,err:=d.GetRequiredAgents(ctx,group)
	if err!=nil || !reflect.DeepEqual(items,[]string{"Original custom sensor"}){t.Fatal("partial replacement committed",items,err)}
	start:=make(chan struct{});results:=make(chan error,2);var wg sync.WaitGroup
	for _,names:=range [][]string{{"A1","A2"},{"B1","B2"}} {
		wg.Add(1)
		go func(names []string){defer wg.Done();<-start;results<-d.SetRequiredAgents(ctx,group,names)}(names)
	}
	close(start);wg.Wait();close(results)
	for err:=range results{if err!=nil{t.Fatal(err)}}
	items,err=d.GetRequiredAgents(ctx,group)
	if err!=nil || (!reflect.DeepEqual(items,[]string{"A1","A2"}) && !reflect.DeepEqual(items,[]string{"B1","B2"})){t.Fatal("concurrent replacements mixed sets",items,err)}
	if err=d.SetRequiredAgents(ctx,group,[]string{});err!=nil{t.Fatal(err)}
	items,err=d.GetRequiredAgents(ctx,group)
	if err!=nil || len(items)!=0{t.Fatal("explicit clear did not persist",items,err)}
	if err=d.SetRequiredAgents(ctx,uuid.NewString(),[]string{});err==nil{t.Fatal("empty save accepted missing group")}
}
