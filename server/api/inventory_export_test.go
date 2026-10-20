package api

import (
	"context"
	"encoding/csv"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sms/server-mgmt/server/db"
)

type exportStoreStub struct { agents []*db.Agent; calls int; err error }
func (s *exportStoreStub) ListAgents(context.Context) ([]*db.Agent,error) {s.calls++;return s.agents,s.err}

func TestInventoryExportScopeAndCSVBoundaries(t *testing.T) {
	a,b:=scopeA,scopeB
	for _,tc:=range []struct {name string;claims *JWTClaims;status,rows int}{
		{"anonymous",nil,401,0},
		{"no-permission",roleClaims("custom",nil),403,0},
		{"admin",roleClaims("admin",[]string{a}),200,4},
		{"operator-A",roleClaims("operator",[]string{a}),200,2},
		{"readonly-B",roleClaims("readonly",[]string{b}),200,2},
		{"custom-A",roleClaims("custom",[]string{a},"servers.read"),200,2},
		{"global-readonly",roleClaims("readonly",nil),200,4},
	} {
		t.Run(tc.name,func(t *testing.T){
			store:=&exportStoreStub{agents:[]*db.Agent{
				{ID:"allowed",Hostname:"=HYPERLINK(\"synthetic\")",OS:"Test,OS",GroupID:&a,GroupName:"Group\nA"},
				{ID:"foreign",Hostname:"Foreign host",GroupID:&b},
				{ID:"ungrouped",Hostname:"Ungrouped host"},
			}}
			r:=httptest.NewRequest("GET","/api/reports/export?format=csv",nil)
			if tc.claims!=nil{r=r.WithContext(context.WithValue(r.Context(),ctxUser,tc.claims))}
			w:=httptest.NewRecorder();(&Server{}).exportInventory(w,r,store)
			if w.Code!=tc.status{t.Fatalf("status %d",w.Code)}
			if tc.status!=200{if store.calls!=0{t.Fatal("denied export queried data")};return}
			rows,err:=csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
			if err!=nil || len(rows)!=tc.rows{t.Fatalf("CSV rows=%d err=%v",len(rows),err)}
			for _,row:=range rows {if len(row)!=6{t.Fatal("CSV field boundary escaped")}}
			if tc.name=="operator-A" || tc.name=="custom-A" {
				if strings.Contains(w.Body.String(),"Foreign host") || strings.Contains(w.Body.String(),"Ungrouped host"){t.Fatal("export disclosed another scope")}
				if rows[1][1]!="'=HYPERLINK(\"synthetic\")" || rows[1][2]!="Test,OS" || rows[1][5]!="'Group\nA"{t.Fatal("unsafe CSV encoding",rows[1])}
			}
			if tc.name=="readonly-B" && strings.Contains(w.Body.String(),"HYPERLINK"){t.Fatal("reverse scope isolation failed")}
			if w.Header().Get("Cache-Control")!="no-store"{t.Fatal("missing export cache policy")}
		})
	}
}

func TestInventoryExportFailureAndEmptyState(t *testing.T) {
	for _,err:=range []error{nil,errors.New("synthetic-private")} {
		r:=httptest.NewRequest("GET","/api/reports/export?format=csv",nil)
		r=r.WithContext(context.WithValue(r.Context(),ctxUser,roleClaims("admin",nil)))
		w:=httptest.NewRecorder();(&Server{}).exportInventory(w,r,&exportStoreStub{err:err})
		if err==nil {
			if w.Code!=200 || w.Body.String()!="ID,Hostname,OS,Status,Last Seen,Group\n"{t.Fatal("empty export fabricated data")}
		} else if w.Code!=503 || strings.Contains(w.Body.String(),"synthetic-private") {t.Fatal("unsafe database error")}
	}
	for _,value:=range []string{"=formula"," +formula","-formula","@formula","\tformula","\rformula","\nformula"} {
		if !strings.HasPrefix(inventoryCSVCell(value),"'"){t.Fatal("formula not neutralized")}
	}
}
