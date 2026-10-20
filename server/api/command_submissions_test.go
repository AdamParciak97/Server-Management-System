package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sms/server-mgmt/server/db"
	"github.com/sms/server-mgmt/shared"
)

type submissionStub struct {
	calls int
	user,key,agent,group string
	cmd shared.Command
	scopes []string
	err error
}
func (s *submissionStub) SubmitCommands(_ context.Context,user,key,agent,group string,cmd shared.Command,scopes []string)(*db.CommandReceipt,error){
	s.calls++;s.user=user;s.key=key;s.agent=agent;s.group=group;s.cmd=cmd;s.scopes=scopes
	return &db.CommandReceipt{RequestKey:key,Targets:[]db.CommandTargetReceipt{}},s.err
}

const submissionUser="10000000-0000-0000-0000-000000000010"
const submissionKey="10000000-0000-0000-0000-000000000011"
const submissionBody=`{"agent_id":"10000000-0000-0000-0000-000000000001","type":"force_report"}`

func TestCommandSubmissionAuthorizationAndValidation(t *testing.T){
	admin:=&JWTClaims{UserID:submissionUser,Role:"admin"}
	for _,tc:=range []struct{name,body,key string;claims *JWTClaims;status int}{
		{"anonymous",submissionBody,submissionKey,nil,401},
		{"readonly",submissionBody,submissionKey,&JWTClaims{UserID:submissionUser,Role:"readonly"},403},
		{"empty identity",submissionBody,submissionKey,&JWTClaims{Role:"admin"},401},
		{"valid",submissionBody,submissionKey,admin,200},
		{"generated key",submissionBody,"",admin,200},
		{"null","null",submissionKey,admin,400},
		{"extra JSON",submissionBody+` {}`,submissionKey,admin,400},
		{"unknown field",strings.Replace(submissionBody,`"type"`,`"owner":"other","type"`,1),submissionKey,admin,400},
		{"bad key",submissionBody,"not-uuid",admin,400},
		{"bad target",strings.Replace(submissionBody,inventoryGroup,"bad",1),submissionKey,admin,400},
		{"two targets",strings.Replace(submissionBody,`"type"`,`"group_id":"`+inventoryGroup+`","type"`,1),submissionKey,admin,400},
		{"no target",`{"type":"force_report"}`,submissionKey,admin,400},
		{"unknown type",strings.Replace(submissionBody,"force_report","arbitrary",1),submissionKey,admin,400},
		{"bad priority",strings.Replace(submissionBody,`"type"`,`"priority":"urgent","type"`,1),submissionKey,admin,400},
		{"bad timeout",strings.Replace(submissionBody,`"type"`,`"timeout_seconds":-1,"type"`,1),submissionKey,admin,400},
		{"huge timeout",strings.Replace(submissionBody,`"type"`,`"timeout_seconds":86401,"type"`,1),submissionKey,admin,400},
		{"script missing",strings.Replace(submissionBody,"force_report","run_script",1),submissionKey,admin,400},
		{"service missing",strings.Replace(submissionBody,"force_report","service_control",1),submissionKey,admin,400},
		{"package missing",strings.Replace(submissionBody,"force_report","install_package",1),submissionKey,admin,400},
		{"payload type",strings.Replace(submissionBody,`"type"`,`"payload":{"args":"not-array"},"type"`,1),submissionKey,admin,400},
		{"payload unknown",strings.Replace(submissionBody,`"type"`,`"payload":{"typo":true},"type"`,1),submissionKey,admin,400},
		{"size limit",strings.Replace(submissionBody,`"type"`,`"payload":{"script_content":"`+strings.Repeat("x",128<<10)+`"},"type"`,1),submissionKey,admin,400},
		{"foreign group",`{"group_id":"`+inventoryOther+`","type":"force_report"}`,submissionKey,&JWTClaims{UserID:submissionUser,Role:"operator",Permissions:[]string{"commands.write"},GroupScopes:[]string{inventoryGroup}},404},
	}{t.Run(tc.name,func(t *testing.T){
		r:=httptest.NewRequest("POST","/api/commands",strings.NewReader(tc.body));r.Header.Set("Idempotency-Key",tc.key)
		if tc.claims!=nil{r=r.WithContext(context.WithValue(r.Context(),ctxUser,tc.claims))}
		w:=httptest.NewRecorder();store:=&submissionStub{};(&Server{}).submitCommands(w,r,store)
		if w.Code!=tc.status{t.Fatalf("got %d: %s",w.Code,w.Body.String())}
		if tc.status!=200 && store.calls!=0{t.Fatal("invalid request reached storage")}
		if tc.status==200 && (store.calls!=1 || store.user!=submissionUser || store.key=="" || store.cmd.Timeout!=1800 || store.cmd.Priority!=shared.PriorityNormal){t.Fatal("identity/defaults lost")}
		if w.Header().Get("Cache-Control")!="no-store"{t.Fatal("receipt cacheable")}
	})}
}

func TestCommandSubmissionScopeAndStoreErrors(t *testing.T){
	for _,tc:=range []struct{err error;status int}{{nil,200},{db.ErrCommandSubmissionConflict,409},{db.ErrScopedResourceMissing,404},{db.ErrCommandTargetLimit,422},{errors.New("synthetic private SQL detail"),503}}{
		r:=httptest.NewRequest("POST","/api/commands",strings.NewReader(submissionBody));r.Header.Set("Idempotency-Key",submissionKey)
		r=r.WithContext(context.WithValue(r.Context(),ctxUser,&JWTClaims{UserID:submissionUser,Role:"operator",Permissions:[]string{"commands.write"},GroupScopes:[]string{inventoryGroup}}))
		w:=httptest.NewRecorder();store:=&submissionStub{err:tc.err};(&Server{}).submitCommands(w,r,store)
		if w.Code!=tc.status || store.user!=submissionUser || store.key!=submissionKey || len(store.scopes)!=1 || store.scopes[0]!=inventoryGroup{t.Fatalf("scope/status lost: %d %s",w.Code,w.Body.String())}
		if strings.Contains(w.Body.String(),"private SQL"){t.Fatal("storage details exposed")}
	}
}
