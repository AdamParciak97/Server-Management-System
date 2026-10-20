package db

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/sms/server-mgmt/shared"
)

func submissionPostgres(t *testing.T)(*DB,string,string,string){
	t.Helper();d,user,a,b:=inventoryPostgres(t)
	_,err:=d.Pool.Exec(context.Background(),`CREATE TABLE commands (
		id UUID PRIMARY KEY,agent_id UUID REFERENCES agents(id),group_id UUID REFERENCES groups(id),
		type TEXT NOT NULL,priority TEXT NOT NULL,payload JSONB NOT NULL,dry_run BOOLEAN NOT NULL,
		timeout_seconds INT NOT NULL,created_by UUID REFERENCES users(id),status TEXT NOT NULL,requires_approval BOOLEAN NOT NULL)`)
	if err!=nil{t.Fatal(err)}
	migration,err:=os.ReadFile("../migrations/014_command_submissions.up.sql");if err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(context.Background(),string(migration));err!=nil{t.Fatal(err)}
	return d,user,a,b
}

func TestPostgresSubmissionConcurrentReplayAndChangedPayload(t *testing.T){
	d,user,group,_:=submissionPostgres(t);ctx:=context.Background();key:=uuid.New().String()
	cmd:=shared.Command{Type:shared.CmdRunScript,Priority:shared.PriorityNormal,Timeout:60,Payload:shared.CommandPayload{ScriptContent:"echo synthetic",ScriptType:"bash"}}
	var wg sync.WaitGroup;receipts:=make(chan *CommandReceipt,8)
	for n:=0;n<8;n++{wg.Add(1);go func(){defer wg.Done();r,err:=d.SubmitCommands(ctx,user,key,"",group,cmd,[]string{group});if err!=nil{t.Error(err);return};receipts<-r}()};wg.Wait();close(receipts)
	fresh:=0;ids:=map[string]bool{}
	for r:=range receipts{if !r.Replayed{fresh++};if r.CommandsCreated!=6{t.Fatal("missing targets",r)};for _,target:=range r.Targets{ids[target.CommandID]=true;if target.Status!="awaiting_approval"{t.Fatal("approval missing")}}}
	if fresh!=1 || len(ids)!=6{t.Fatal("duplicates",fresh,len(ids))}
	var commands,approvals,audit int
	if err:=d.Pool.QueryRow(ctx,`SELECT count(*),count(*) FILTER(WHERE requires_approval) FROM commands`).Scan(&commands,&approvals);err!=nil{t.Fatal(err)}
	if err:=d.Pool.QueryRow(ctx,`SELECT count(*) FROM audit_log WHERE action='commands.submit'`).Scan(&audit);err!=nil{t.Fatal(err)}
	if commands!=6 || approvals!=6 || audit!=1{t.Fatal("non-atomic command/audit",commands,approvals,audit)}
	cmd.Timeout=61
	if _,err:=d.SubmitCommands(ctx,user,key,"",group,cmd,nil);!errors.Is(err,ErrCommandSubmissionConflict){t.Fatal("changed retry accepted",err)}
	// Rollback of the migration preserves deduplication evidence.
	down,err:=os.ReadFile("../migrations/014_command_submissions.down.sql");if err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(ctx,string(down));err!=nil{t.Fatal(err)}
	cmd.Timeout=60
	if r,err:=d.SubmitCommands(ctx,user,key,"",group,cmd,nil);err!=nil || !r.Replayed{t.Fatal("rollback lost receipt",err)}
}

func TestPostgresSubmissionOwnerScopeAndFrozenMembership(t *testing.T){
	d,user,a,b:=submissionPostgres(t);ctx:=context.Background();key:=uuid.New().String()
	cmd:=shared.Command{Type:shared.CmdForceReport,Priority:shared.PriorityNormal,Timeout:60}
	r,err:=d.SubmitCommands(ctx,user,key,"",a,cmd,[]string{a});if err!=nil{t.Fatal(err)}
	other:=uuid.New().String();if _,err=d.Pool.Exec(ctx,`INSERT INTO users(id,username,password_hash) VALUES($1,'other-submitter','synthetic')`,other);err!=nil{t.Fatal(err)}
	second,err:=d.SubmitCommands(ctx,other,key,"",a,cmd,[]string{a});if err!=nil || second.Replayed || second.Targets[0].CommandID==r.Targets[0].CommandID{t.Fatal("cross-owner receipt",err)}
	if _,err=d.SubmitCommands(ctx,user,key,"",a,cmd,[]string{});!errors.Is(err,ErrScopedResourceMissing){t.Fatal("empty scope widened",err)}
	if _,err=d.SubmitCommands(ctx,user,uuid.New().String(),r.Targets[0].AgentID,"",cmd,[]string{b});!errors.Is(err,ErrScopedResourceMissing){t.Fatal("foreign target accepted",err)}
	if _,err=d.Pool.Exec(ctx,`UPDATE agents SET group_id=$2 WHERE id=$1`,r.Targets[0].AgentID,b);err!=nil{t.Fatal(err)}
	if _,err=d.SubmitCommands(ctx,user,key,"",a,cmd,[]string{a});!errors.Is(err,ErrScopedResourceMissing){t.Fatal("moved target leaked",err)}
	if _,err=d.Pool.Exec(ctx,`INSERT INTO agents(id,hostname,status,group_id) VALUES($1,'new-member','online',$2)`,uuid.New().String(),a);err!=nil{t.Fatal(err)}
	replay,err:=d.SubmitCommands(ctx,user,key,"",a,cmd,nil);if err!=nil || replay.CommandsCreated!=6 || !replay.Replayed{t.Fatal("replay expanded target set",err)}
}

func TestPostgresSubmissionRollbackIncludingAuditAndEmptyGroup(t *testing.T){
	d,user,a,_:=submissionPostgres(t);ctx:=context.Background();key:=uuid.New().String()
	cmd:=shared.Command{Type:shared.CmdForceReport,Priority:shared.PriorityNormal,Timeout:60}
	// Fail after command inserts: the receipt and every command must roll back.
	if _,err:=d.Pool.Exec(ctx,`ALTER TABLE audit_log ADD CONSTRAINT reject_submission CHECK(action <> 'commands.submit')`);err!=nil{t.Fatal(err)}
	if _,err:=d.SubmitCommands(ctx,user,key,"",a,cmd,nil);err==nil{t.Fatal("expected audit failure")}
	for _,table:=range []string{"commands","command_submissions"}{var count int;if err:=d.Pool.QueryRow(ctx,`SELECT count(*) FROM `+table).Scan(&count);err!=nil || count!=0{t.Fatal("partial write survived",table,count,err)}}
	if _,err:=d.Pool.Exec(ctx,`ALTER TABLE audit_log DROP CONSTRAINT reject_submission`);err!=nil{t.Fatal(err)}
	if r,err:=d.SubmitCommands(ctx,user,key,"",a,cmd,nil);err!=nil || r.Replayed || r.CommandsCreated!=6{t.Fatal("retry after rollback",err)}
	empty:=uuid.New().String();if _,err:=d.Pool.Exec(ctx,`INSERT INTO groups(id,name) VALUES($1,'Empty')`,empty);err!=nil{t.Fatal(err)}
	key=uuid.New().String();r,err:=d.SubmitCommands(ctx,user,key,"",empty,cmd,nil);if err!=nil || len(r.Targets)!=0{t.Fatal("empty group",err)}
	if _,err=d.Pool.Exec(ctx,`INSERT INTO agents(id,hostname,status,group_id) VALUES($1,'later','online',$2)`,uuid.New().String(),empty);err!=nil{t.Fatal(err)}
	r,err=d.SubmitCommands(ctx,user,key,"",empty,cmd,nil);if err!=nil || !r.Replayed || len(r.Targets)!=0{t.Fatal("empty retry gained targets",err)}
}
