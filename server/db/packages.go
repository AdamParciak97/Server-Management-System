package db

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type PackageRecord struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Version     string    `json:"version"`
	OSTarget    string    `json:"os_target"`
	ArchTarget  string    `json:"arch_target"`
	FilePath    string    `json:"file_path"`
	FileSize    int64     `json:"file_size"`
	SHA256      string    `json:"sha256"`
	Description string    `json:"description,omitempty"`
	UploadedBy  *string   `json:"uploaded_by,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

func (d *DB) CreatePackage(ctx context.Context, p PackageRecord) (*PackageRecord, error) {
	p.ID = uuid.New().String()
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO packages (id, name, version, os_target, arch_target, file_path, file_size, sha256, description, uploaded_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		p.ID, p.Name, p.Version, p.OSTarget, p.ArchTarget,
		p.FilePath, p.FileSize, p.SHA256, p.Description, p.UploadedBy)
	if err != nil {
		return nil, err
	}
	p.CreatedAt = time.Now()
	return &p, nil
}

func (d *DB) ListPackages(ctx context.Context) ([]*PackageRecord, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, name, version, COALESCE(os_target,''), COALESCE(arch_target,''),
			file_path, COALESCE(file_size,0), sha256, COALESCE(description,''),
			uploaded_by, created_at
		FROM packages ORDER BY name, version DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pkgs []*PackageRecord
	for rows.Next() {
		var p PackageRecord
		err := rows.Scan(&p.ID, &p.Name, &p.Version, &p.OSTarget, &p.ArchTarget,
			&p.FilePath, &p.FileSize, &p.SHA256, &p.Description, &p.UploadedBy, &p.CreatedAt)
		if err != nil {
			return nil, err
		}
		pkgs = append(pkgs, &p)
	}
	return pkgs, rows.Err()
}

func (d *DB) GetPackage(ctx context.Context, id string) (*PackageRecord, error) {
	var p PackageRecord
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, version, COALESCE(os_target,''), COALESCE(arch_target,''),
			file_path, COALESCE(file_size,0), sha256, COALESCE(description,''),
			uploaded_by, created_at
		FROM packages WHERE id = $1`, id).
		Scan(&p.ID, &p.Name, &p.Version, &p.OSTarget, &p.ArchTarget,
			&p.FilePath, &p.FileSize, &p.SHA256, &p.Description, &p.UploadedBy, &p.CreatedAt)
	return &p, err
}

func (d *DB) DeletePackage(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM packages WHERE id = $1`, id)
	return err
}

func (d *DB) GetLatestPackageForTarget(ctx context.Context, name, osTarget, archTarget string) (*PackageRecord, error) {
	var p PackageRecord
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, version, COALESCE(os_target,''), COALESCE(arch_target,''),
			file_path, COALESCE(file_size,0), sha256, COALESCE(description,''),
			uploaded_by, created_at
		FROM packages
		WHERE name = $1
		  AND COALESCE(os_target, '') IN ('', $2)
		  AND COALESCE(arch_target, '') IN ('', $3)
		ORDER BY created_at DESC
		LIMIT 1`, name, osTarget, archTarget).
		Scan(&p.ID, &p.Name, &p.Version, &p.OSTarget, &p.ArchTarget,
			&p.FilePath, &p.FileSize, &p.SHA256, &p.Description, &p.UploadedBy, &p.CreatedAt)
	return &p, err
}
