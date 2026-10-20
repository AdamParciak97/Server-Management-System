package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestInventoryPredicatesAreBoundAndScoped(t *testing.T){
	f:=InventoryFilter{Search:"%' OR true --",Group:"10000000-0000-0000-0000-000000000001",Status:"offline",OS:"linux"}
	where,args:=inventoryPredicate(f,[]string{"allowed"})
	if strings.Contains(where,f.Search) || strings.Contains(where,f.Group) || strings.Contains(where,"allowed"){t.Fatal("input interpolated in SQL")}
	if len(args)!=5 || !strings.Contains(where,"a.group_id = ANY($1::uuid[])") || !strings.Contains(where,"strpos") {t.Fatal("scope/filter not bound",where,args)}
	where,args=inventoryPredicate(InventoryFilter{Group:"__ungrouped__"},[]string{})
	if !strings.Contains(where,"ANY($1::uuid[])") || !strings.Contains(where,"IS NULL") || len(args)!=1{t.Fatal("empty scope widened")}
	where,args=inventoryPredicate(InventoryFilter{},nil)
	if where!="TRUE" || len(args)!=0{t.Fatal("unrestricted predicate changed")}
}

func TestInventoryFilterValidation(t *testing.T){
	f:=InventoryFilter{Search:"  host  "};if err:=f.Validate();err!=nil || f.Search!="host" || f.PageSize!=25 || f.Sort!="name"{t.Fatal("bad defaults",err)}
	for _,bad:=range []InventoryFilter{{Search:strings.Repeat("a",201)},{Search:"a\x00b"},{Status:"other"},{Group:"not uuid"},{OS:"other"},{Sort:"name;DROP"},{PageSize:-1},{PageSize:101}}{if bad.Validate()==nil{t.Fatal("invalid filter accepted",bad)}}
}

func inventoryPostgres(t *testing.T)(*DB,string,string,string){
	t.Helper();d,user:=sessionPostgres(t);ctx:=context.Background()
	_,err:=d.Pool.Exec(ctx,`CREATE TABLE groups(id UUID PRIMARY KEY,name TEXT);
		CREATE TABLE agents(id UUID PRIMARY KEY,hostname TEXT NOT NULL,fqdn TEXT,ip_addresses TEXT[] DEFAULT '{}',os TEXT,os_version TEXT,architecture TEXT,agent_version TEXT,group_id UUID REFERENCES groups(id),tags UUID[] DEFAULT '{}',last_seen TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'unknown',registered_at TIMESTAMPTZ DEFAULT NOW());`)
	if err!=nil{t.Fatal(err)}
	a,b:=uuid.New().String(),uuid.New().String()
	if _,err=d.Pool.Exec(ctx,`INSERT INTO groups(id,name) VALUES($1,'Allowed'),($2,'Other')`,a,b);err!=nil{t.Fatal(err)}
	// Real migration on a populated synthetic schema; existing hosts must survive.
	for n:=0;n<7;n++{
		group:=a;if n==6{group=b}
		status:="online";if n%2==0{status="offline"}
		name:=fmt.Sprintf("host-%02d",n);if n==0{name="host-%_literal"}
		if _,err=d.Pool.Exec(ctx,`INSERT INTO agents(id,hostname,fqdn,ip_addresses,os,group_id,status,last_seen) VALUES($1,$2,$3,ARRAY['2001:db8::42'],'Linux',$4,$5,CASE WHEN $6 THEN NULL ELSE NOW() END)`,uuid.New().String(),name,name+".example.test",group,status,n==0);err!=nil{t.Fatal(err)}
	}
	migration,err:=os.ReadFile("../migrations/012_inventory_views.up.sql");if err!=nil{t.Fatal(err)}
	if _,err=d.Pool.Exec(ctx,string(migration));err!=nil{t.Fatal(err)}
	return d,user,a,b
}

func TestPostgresInventoryPaginationScopeAndFilters(t *testing.T){
	d,_,a,b:=inventoryPostgres(t);ctx:=context.Background()
	f:=InventoryFilter{PageSize:2,Sort:"name"}
	seen:=map[string]bool{}
	for page:=1;page<=3;page++{
		result,err:=d.ListInventory(ctx,f,page,[]string{a});if err!=nil{t.Fatal(err)}
		if result.Total!=6 || result.Summary.Total!=6 || len(result.Items)!=2 || result.Page!=page{t.Fatalf("wrong bounded result: %+v",result)}
		for _,host:=range result.Items{if *host.GroupID!=a || seen[host.ID]{t.Fatal("foreign or repeated host")};seen[host.ID]=true}
	}
	f.Status="offline";result,err:=d.ListInventory(ctx,f,100,[]string{a})
	if err!=nil || result.Total!=3 || result.Page!=2 || len(result.Items)!=1 || result.Summary.Total!=6{t.Fatal("bad filtered/clamped page",result,err)}
	f.Group=b;result,err=d.ListInventory(ctx,f,1,[]string{a});if err!=nil || result.Total!=0 || len(result.Items)!=0{t.Fatal("explicit foreign group widened scope",err)}
	f=InventoryFilter{Search:"%_",PageSize:25};result,err=d.ListInventory(ctx,f,1,[]string{a});if err!=nil || result.Total!=1{t.Fatal("wildcards were not literal",err)}
	f.Search="  2001:DB8::42  ";result,err=d.ListInventory(ctx,f,1,[]string{a});if err!=nil || result.Total!=6{t.Fatal("IPv6/trim failed",err)}
	f.Search="example.test";f.Sort="seen";result,err=d.ListInventory(ctx,f,1,[]string{a});if err!=nil || result.Total!=6 || result.Items[5].LastSeen!=nil{t.Fatal("FQDN or null sort failed",err)}
	result,err=d.ListInventory(ctx,InventoryFilter{},1,[]string{});if err!=nil || result.Total!=0 || result.Summary.Total!=0{t.Fatal("empty scope leaked totals",err)}
	result,err=d.ListInventory(ctx,InventoryFilter{},1,nil);if err!=nil || result.Total!=7{t.Fatal("migration changed hosts",err)}
}

func TestPostgresInventoryViewsOwnershipRoundtripAndQuota(t *testing.T){
	d,user,a,_:=inventoryPostgres(t);ctx:=context.Background()
	other:=uuid.New().String();if _,err:=d.Pool.Exec(ctx,`INSERT INTO users(id,username,password_hash) VALUES($1,'other','synthetic')`,other);err!=nil{t.Fatal(err)}
	f:=InventoryFilter{Search:"%_",Status:"offline",Group:a,OS:"linux",Sort:"seen",PageSize:50}
	v,err:=d.SaveInventoryView(ctx,user,"","Original",f);if err!=nil{t.Fatal(err)}
	if _,err=d.SaveInventoryView(ctx,other,v.ID,"Stolen",f);!errors.Is(err,ErrInventoryViewMissing){t.Fatal("foreign update",err)}
	if err=d.DeleteInventoryView(ctx,other,v.ID);!errors.Is(err,ErrInventoryViewMissing){t.Fatal("foreign delete",err)}
	items,err:=d.ListInventoryViews(ctx,other);if err!=nil || len(items)!=0{t.Fatal("foreign list",err)}
	items,err=d.ListInventoryViews(ctx,user);if err!=nil || len(items)!=1 || items[0].Name!="Original" || items[0].Filters!=f{t.Fatal("saved filters changed",err)}
	if _,err=d.SaveInventoryView(ctx,user,v.ID,"Renamed",f);err!=nil{t.Fatal(err)}
	if err=d.DeleteInventoryView(ctx,user,v.ID);err!=nil{t.Fatal(err)}
	if err=d.DeleteInventoryView(ctx,user,v.ID);!errors.Is(err,ErrInventoryViewMissing){t.Fatal("missing view not reported")}
	var successes atomic.Int32;var wg sync.WaitGroup
	for n:=0;n<24;n++{wg.Add(1);go func(){defer wg.Done();_,err:=d.SaveInventoryView(ctx,user,"","Concurrent",f);if err==nil{successes.Add(1)}else if !errors.Is(err,ErrInventoryViewLimit){t.Error(err)}}()};wg.Wait()
	items,err=d.ListInventoryViews(ctx,user);if err!=nil || len(items)!=20 || successes.Load()!=20{t.Fatal("concurrent quota exceeded",len(items),successes.Load(),err)}
	if _,err=d.SaveInventoryView(ctx,user,items[0].ID,"Update at limit",f);err!=nil{t.Fatal("quota blocked update",err)}
}
