package db

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/sms/server-mgmt/shared"
)

var ErrCommandSubmissionConflict = errors.New("request key already used for different command")
var ErrCommandTargetLimit = errors.New("command target limit exceeded")

func scopedCommandError(err error) error {
	if errors.Is(err,pgx.ErrNoRows) { return ErrScopedResourceMissing }
	return err
}

type CommandTargetReceipt struct {
	AgentID string `json:"agent_id"`
	Hostname string `json:"hostname"`
	CommandID string `json:"command_id"`
	Status string `json:"status"`
}

type CommandReceipt struct {
	RequestKey string `json:"request_key"`
	ID string `json:"id,omitempty"` // compatibility for single-target callers
	CommandsCreated int `json:"commands_created"`
	CreatedAt time.Time `json:"created_at"`
	Replayed bool `json:"replayed"`
	Targets []CommandTargetReceipt `json:"targets"`
}

// All targets, the audit entry and the receipt commit together. A conflict on
// (user,key) waits for the first transaction, including concurrent HTTP retries.
func (d *DB) SubmitCommands(ctx context.Context, user, key, agent, group string, cmd shared.Command, scopes []string) (*CommandReceipt, error) {
	canonical, err := json.Marshal(struct { Agent, Group string; Command shared.Command }{agent, group, cmd})
	if err != nil { return nil, err }
	hash := sha256.Sum256(canonical)
	fingerprint := hex.EncodeToString(hash[:])
	tx, err := d.Pool.Begin(ctx)
	if err != nil { return nil, err }
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO command_submissions(user_id,request_key,request_hash)
		VALUES($1,$2,$3) ON CONFLICT(user_id,request_key) DO NOTHING`, user,key,fingerprint)
	if err != nil { return nil, err }
	if tag.RowsAffected() == 0 {
		var savedHash string
		var raw []byte
		if err = tx.QueryRow(ctx, `SELECT request_hash,receipt FROM command_submissions WHERE user_id=$1 AND request_key=$2`,user,key).Scan(&savedHash,&raw); err != nil { return nil,err }
		if savedHash != fingerprint { return nil,ErrCommandSubmissionConflict }
		var receipt CommandReceipt
		if err = json.Unmarshal(raw,&receipt); err != nil { return nil,err }
		// Recheck current access, never expose an old receipt across a scope change.
		ids := make([]string,0,len(receipt.Targets))
		for _, target := range receipt.Targets { ids=append(ids,target.AgentID) }
		rows, e := tx.Query(ctx, `SELECT id FROM agents WHERE id=ANY($1::uuid[])
			AND ($2::uuid[] IS NULL OR group_id=ANY($2::uuid[])) ORDER BY id FOR SHARE`,ids,scopes)
		if e != nil { return nil,e }
		count:=0
		for rows.Next() { count++ }
		e=rows.Err(); rows.Close()
		if e != nil { return nil,e }
		if count != len(ids) { return nil,ErrScopedResourceMissing }
		receipt.Replayed=true
		return &receipt,nil
	}
	if group != "" {
		var id string
		if err=tx.QueryRow(ctx, `SELECT id FROM groups WHERE id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) FOR SHARE`,group,scopes).Scan(&id); err != nil {
			return nil, scopedCommandError(err)
		}
	}
	// SHARE locks serialize group moves/deletion against target selection + insert.
	rows,err:=tx.Query(ctx, `SELECT id,hostname FROM agents
		WHERE (($1::uuid IS NOT NULL AND id=$1) OR ($2::uuid IS NOT NULL AND group_id=$2))
		AND ($3::uuid[] IS NULL OR group_id=ANY($3::uuid[]))
		ORDER BY id LIMIT 1001 FOR SHARE`,toNullStr(agent),toNullStr(group),scopes)
	if err != nil { return nil,err }
	receipt:=&CommandReceipt{RequestKey:key,CreatedAt:time.Now().UTC(),Targets:[]CommandTargetReceipt{}}
	for rows.Next() {
		var target CommandTargetReceipt
		if err=rows.Scan(&target.AgentID,&target.Hostname);err!=nil{rows.Close();return nil,err}
		target.CommandID=uuid.New().String(); target.Status="pending"
		if cmd.Type==shared.CmdRunScript && !cmd.DryRun { target.Status="awaiting_approval" }
		receipt.Targets=append(receipt.Targets,target)
	}
	err=rows.Err();rows.Close()
	if err!=nil{return nil,err}
	if agent!="" && len(receipt.Targets)==0 {return nil,ErrScopedResourceMissing}
	if len(receipt.Targets)>1000{return nil,ErrCommandTargetLimit}
	for _,target:=range receipt.Targets{
		if err=insertCommand(ctx,tx,target.CommandID,&target.AgentID,nil,cmd,&user);err!=nil{return nil,err}
	}
	receipt.CommandsCreated=len(receipt.Targets)
	if agent!="" {receipt.ID=receipt.Targets[0].CommandID}
	raw,err:=json.Marshal(receipt);if err!=nil{return nil,err}
	if _,err=tx.Exec(ctx,`UPDATE command_submissions SET receipt=$3 WHERE user_id=$1 AND request_key=$2`,user,key,raw);err!=nil{return nil,err}
	if _,err=tx.Exec(ctx,`INSERT INTO audit_log(user_id,username,action,result)
		SELECT id,username,'commands.submit','success' FROM users WHERE id=$1`,user);err!=nil{return nil,err}
	if err=tx.Commit(ctx);err!=nil{return nil,err}
	return receipt,nil
}
