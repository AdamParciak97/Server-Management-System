package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type InventoryFilter struct {
	Search string `json:"search"`
	Status string `json:"status"`
	Group string `json:"group"`
	OS string `json:"os"`
	Sort string `json:"sort"`
	PageSize int `json:"page_size"`
}

func (f *InventoryFilter) Validate() error {
	f.Search = strings.TrimSpace(f.Search)
	if len(f.Search) > 200 || strings.ContainsRune(f.Search, 0) { return errors.New("search must be at most 200 bytes") }
	if f.Status != "" && f.Status != "online" && f.Status != "offline" && f.Status != "unknown" { return errors.New("invalid status") }
	if f.OS != "" && f.OS != "linux" && f.OS != "windows" { return errors.New("invalid operating system") }
	if f.Group != "" && f.Group != "__ungrouped__" {
		id, err := uuid.Parse(f.Group); if err != nil { return errors.New("invalid group") }; f.Group = id.String()
	}
	if f.Sort == "" { f.Sort = "name" }
	if f.Sort != "name" && f.Sort != "seen" && f.Sort != "status" { return errors.New("invalid sort") }
	if f.PageSize == 0 { f.PageSize = 25 }
	if f.PageSize < 1 || f.PageSize > 100 { return errors.New("page_size must be between 1 and 100") }
	return nil
}

type InventorySummary struct {
	Total int `json:"total"`
	Online int `json:"online"`
	Offline int `json:"offline"`
	Unknown int `json:"unknown"`
}

type InventoryPage struct {
	Items []*Agent `json:"items"`
	Total int `json:"total"`
	Page int `json:"page"`
	PageSize int `json:"page_size"`
	Summary InventorySummary `json:"summary"`
}

// nil scopes means unrestricted; a non-nil empty scope deliberately returns no hosts.
func inventoryPredicate(f InventoryFilter, scopes []string) (string, []any) {
	parts := []string{"TRUE"}; args := []any{}
	add := func(expression string, value any) { args = append(args, value); parts = append(parts, fmt.Sprintf(expression, len(args))) }
	if scopes != nil { add("a.group_id = ANY($%d::uuid[])", scopes) }
	if f.Search != "" {
		// strpos gives literal substring matching, including %, _ and backslashes.
		args = append(args, f.Search); n := len(args)
		parts = append(parts, fmt.Sprintf("(strpos(lower(a.hostname),lower($%[1]d))>0 OR strpos(lower(COALESCE(a.fqdn,'')),lower($%[1]d))>0 OR strpos(lower(COALESCE(array_to_string(a.ip_addresses,' '),'')),lower($%[1]d))>0)", n))
	}
	if f.Status == "unknown" { parts = append(parts, "a.status NOT IN ('online','offline')") } else if f.Status != "" { add("a.status = $%d", f.Status) }
	if f.Group == "__ungrouped__" { parts = append(parts, "a.group_id IS NULL") } else if f.Group != "" { add("a.group_id = $%d::uuid", f.Group) }
	if f.OS != "" { add("strpos(lower(COALESCE(a.os,'')),$%d)>0", f.OS) }
	return strings.Join(parts, " AND "), args
}

func (d *DB) ListInventory(ctx context.Context, f InventoryFilter, page int, scopes []string) (*InventoryPage, error) {
	if err := f.Validate(); err != nil { return nil, err }
	if page < 1 || page > 1000000 { return nil, errors.New("invalid page") }
	tx, err := d.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil { return nil, err }; defer tx.Rollback(ctx)
	result := &InventoryPage{Items: []*Agent{}, Page: page, PageSize: f.PageSize}
	where, args := inventoryPredicate(InventoryFilter{}, scopes)
	err = tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE a.status='online'),count(*) FILTER (WHERE a.status='offline'),count(*) FILTER (WHERE a.status NOT IN ('online','offline')) FROM agents a WHERE `+where, args...).Scan(&result.Summary.Total,&result.Summary.Online,&result.Summary.Offline,&result.Summary.Unknown)
	if err != nil { return nil, err }
	where, args = inventoryPredicate(f, scopes)
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM agents a WHERE `+where, args...).Scan(&result.Total); err != nil { return nil, err }
	last := (result.Total + f.PageSize - 1) / f.PageSize; if last < 1 { last = 1 }; if result.Page > last { result.Page = last }
	order := "lower(a.hostname),a.id"
	if f.Sort == "seen" { order = "a.last_seen DESC NULLS LAST,"+order }
	if f.Sort == "status" { order = "CASE a.status WHEN 'offline' THEN 0 WHEN 'online' THEN 2 ELSE 1 END,"+order }
	args = append(args, f.PageSize, (result.Page-1)*f.PageSize)
	rows, err := tx.Query(ctx, `SELECT a.id,a.hostname,COALESCE(a.fqdn,''),a.ip_addresses,
		COALESCE(a.os,''),COALESCE(a.os_version,''),COALESCE(a.architecture,''),COALESCE(a.agent_version,''),
		a.group_id,COALESCE(g.name,''),COALESCE(a.tags,'{}'),'',a.last_seen,a.status,a.registered_at
		FROM agents a LEFT JOIN groups g ON g.id=a.group_id WHERE `+where+` ORDER BY `+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d",len(args)-1,len(args)), args...)
	if err != nil { return nil, err }
	for rows.Next() { a, scanErr := scanAgent(rows); if scanErr != nil { rows.Close(); return nil,scanErr }; result.Items=append(result.Items,a) }
	err=rows.Err(); rows.Close(); if err != nil { return nil,err }
	if err=tx.Commit(ctx); err != nil { return nil,err }; return result,nil
}

type InventoryView struct {
	ID string `json:"id"`
	Name string `json:"name"`
	Filters InventoryFilter `json:"filters"`
	UpdatedAt time.Time `json:"updated_at"`
}

var ErrInventoryViewMissing = errors.New("inventory view not found")
var ErrInventoryViewLimit = errors.New("maximum 20 saved views per account")

func (d *DB) ListInventoryViews(ctx context.Context, user string) ([]InventoryView,error) {
	rows,err:=d.Pool.Query(ctx,`SELECT id,name,filters,updated_at FROM inventory_views WHERE user_id=$1 ORDER BY lower(name),id`,user)
	if err!=nil{return nil,err};defer rows.Close()
	items:=[]InventoryView{}
	for rows.Next(){var v InventoryView;var raw []byte;if err=rows.Scan(&v.ID,&v.Name,&raw,&v.UpdatedAt);err!=nil{return nil,err};if err=json.Unmarshal(raw,&v.Filters);err!=nil{return nil,err};items=append(items,v)}
	return items,rows.Err()
}

func (d *DB) SaveInventoryView(ctx context.Context,user,id,name string,f InventoryFilter)(*InventoryView,error){
	if err:=f.Validate();err!=nil{return nil,err}
	tx,err:=d.Pool.Begin(ctx);if err!=nil{return nil,err};defer tx.Rollback(ctx)
	// Serialize the per-account quota, including concurrent creates.
	var locked string
	if err=tx.QueryRow(ctx,`SELECT id FROM users WHERE id=$1 FOR UPDATE`,user).Scan(&locked);err!=nil{return nil,err}
	raw,err:=json.Marshal(f);if err!=nil{return nil,err}
	v:=&InventoryView{Name:name,Filters:f}
	if id==""{
		var count int;if err=tx.QueryRow(ctx,`SELECT count(*) FROM inventory_views WHERE user_id=$1`,user).Scan(&count);err!=nil{return nil,err}
		if count>=20{return nil,ErrInventoryViewLimit}
		v.ID=uuid.New().String()
		err=tx.QueryRow(ctx,`INSERT INTO inventory_views(id,user_id,name,filters) VALUES($1,$2,$3,$4) RETURNING updated_at`,v.ID,user,name,raw).Scan(&v.UpdatedAt)
	}else{
		v.ID=id;err=tx.QueryRow(ctx,`UPDATE inventory_views SET name=$3,filters=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING updated_at`,id,user,name,raw).Scan(&v.UpdatedAt)
	}
	if errors.Is(err,pgx.ErrNoRows){return nil,ErrInventoryViewMissing};if err!=nil{return nil,err}
	if err=tx.Commit(ctx);err!=nil{return nil,err};return v,nil
}

func (d *DB) DeleteInventoryView(ctx context.Context,user,id string)error{
	tag,err:=d.Pool.Exec(ctx,`DELETE FROM inventory_views WHERE id=$1 AND user_id=$2`,id,user)
	if err!=nil{return err};if tag.RowsAffected()!=1{return ErrInventoryViewMissing};return nil
}
