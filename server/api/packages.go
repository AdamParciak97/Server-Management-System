package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sms/server-mgmt/server/db"
)

const packageFileLimit int64 = 500 << 20
const packageRequestLimit int64 = packageFileLimit + (1 << 20)

var packageLabel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$`)
var packageFilename = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+() \-]{0,179}$`)

type packageWriter interface {
	CreatePackage(context.Context, db.PackageRecord) (*db.PackageRecord, error)
}

func (s *Server) handlePackageUpload(w http.ResponseWriter, r *http.Request) {
	s.uploadPackage(w, r, s.db, packageRequestLimit, packageFileLimit)
}

// Limits are parameters so tests exercise the real stream with small fixtures.
func (s *Server) uploadPackage(w http.ResponseWriter, r *http.Request, store packageWriter, requestLimit, fileLimit int64) {
	s.requirePermission("packages.write")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > requestLimit {
			respondError(w, http.StatusRequestEntityTooLarge, "package request exceeds size limit")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, requestLimit)
		defer r.Body.Close()
		reader, err := r.MultipartReader()
		if err != nil {
			respondError(w, http.StatusBadRequest, "multipart form required")
			return
		}
		fields := make(map[string]string)
		limits := map[string]int64{"name": 128, "version": 128, "os_target": 16, "arch_target": 16, "description": 4096}
		var tempPath, finalPath, filename string
		var size int64
		hash := sha256.New()
		committed := false
		defer func() {
			// Only paths allocated by this request are ever removed here.
			cleanup := func(path string) {
				if path == "" { return }
				if err := os.Remove(path); err != nil && !os.IsNotExist(err) && s.logger != nil {
					s.logger.Error("failed upload cleanup requires review", "error", err)
				}
			}
			cleanup(tempPath)
			if !committed { cleanup(finalPath) }
		}()
		failRead := func(err error) {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				respondError(w, http.StatusRequestEntityTooLarge, "package request exceeds size limit")
			} else {
				respondError(w, http.StatusBadRequest, "incomplete or invalid package upload")
			}
		}
		for {
			part, err := reader.NextRawPart()
			if err == io.EOF { break }
			if err != nil { failRead(err); return }
			key := part.FormName()
			if part.Header.Get("Content-Transfer-Encoding") != "" {
				respondError(w, http.StatusBadRequest, "encoded multipart parts are not supported")
				return
			}
			if key == "file" {
				// Check the original header: FileName() alone strips path components.
				_, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
				filename = params["filename"]
				if err != nil || tempPath != "" || !packageFilename.MatchString(filename) {
					respondError(w, http.StatusBadRequest, "one file with a plain filename is required (up to 180 ASCII characters)")
					return
				}
				if err := os.MkdirAll(s.uploadDir, 0700); err != nil {
					respondError(w, http.StatusInternalServerError, "package storage unavailable"); return
				}
				file, err := os.CreateTemp(s.uploadDir, ".package-*.partial")
				if err != nil { respondError(w, http.StatusInternalServerError, "package storage unavailable"); return }
				tempPath = file.Name()
				size, err = io.Copy(io.MultiWriter(file, hash), io.LimitReader(part, fileLimit+1))
				if err != nil {
					_ = file.Close()
					var pathErr *os.PathError
					if errors.As(err, &pathErr) { respondError(w, 500, "failed to store package") } else { failRead(err) }
					return
				}
				if size == 0 || size > fileLimit {
					_ = file.Close()
					if size == 0 { respondError(w, 400, "package file is empty") } else { respondError(w, 413, "package file exceeds size limit") }
					return
				}
				syncErr := file.Sync()
				closeErr := file.Close()
				if syncErr != nil || closeErr != nil { respondError(w, 500, "failed to store package"); return }
			} else {
				limit, allowed := limits[key]
				_, duplicate := fields[key]
				if !allowed || duplicate || part.FileName() != "" {
					respondError(w, 400, "unknown or duplicate package field"); return
				}
				value, err := io.ReadAll(io.LimitReader(part, limit+1))
				if err != nil { failRead(err); return }
				if int64(len(value)) > limit { respondError(w, 413, "package metadata exceeds size limit"); return }
				if !utf8.Valid(value) || strings.ContainsRune(string(value), 0) { respondError(w, 400, "invalid package metadata"); return }
				fields[key] = strings.TrimSpace(string(value))
			}
		}
		// Bound the entire body, including bytes after the final multipart boundary.
		if _, err := io.Copy(io.Discard, r.Body); err != nil { failRead(err); return }
		if tempPath == "" || !packageLabel.MatchString(fields["name"]) || !packageLabel.MatchString(fields["version"]) {
			respondError(w, 400, "file, name and version required; use up to 128 letters, digits, dots, underscores, plus or minus"); return
		}
		if (fields["os_target"] != "" && fields["os_target"] != "linux" && fields["os_target"] != "windows") ||
			(fields["arch_target"] != "" && fields["arch_target"] != "amd64" && fields["arch_target"] != "arm64") {
			respondError(w, 400, "unsupported package target"); return
		}
		if r.Context().Err() != nil { respondError(w, 400, "upload interrupted"); return }
		// Publish only a complete, synced file. Names and metadata never form directories.
		finalPath = filepath.Join(s.uploadDir, uuid.NewString()+"_"+filename)
		if err := os.Rename(tempPath, finalPath); err != nil { respondError(w, 500, "failed to publish package"); return }
		userID := getUserFromCtx(r.Context()).UserID
		pkg, err := store.CreatePackage(r.Context(), db.PackageRecord{
			Name: fields["name"], Version: fields["version"], OSTarget: fields["os_target"], ArchTarget: fields["arch_target"],
			Description: fields["description"], FilePath: finalPath, FileSize: size, SHA256: fmt.Sprintf("%x", hash.Sum(nil)), UploadedBy: &userID,
		})
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				respondError(w, http.StatusConflict, "a package with this name, version and target already exists")
			} else {
				respondError(w, 500, "failed to save package record")
			}
			return
		}
		committed = true
		respondOK(w, pkg)
	})).ServeHTTP(w, r)
}

func (s *Server) handleListPackages(w http.ResponseWriter, r *http.Request) {
	pkgs, err := s.db.ListPackages(r.Context())
	if err != nil { respondError(w, 500, "failed to list packages"); return }
	if pkgs == nil { pkgs = []*db.PackageRecord{} }
	respondOK(w, pkgs)
}

// Historical paths are supported only as direct children of the configured store.
// The directory must be writable only by the server, not by untrusted local users.
func (s *Server) packagePath(stored string) (string, error) {
	root, err := filepath.Abs(s.uploadDir)
	if err != nil || stored == "" { return "", errors.New("invalid package path") }
	path, err := filepath.Abs(stored)
	if err != nil || filepath.Dir(path) != root { return "", errors.New("package outside storage") }
	root, err = filepath.EvalSymlinks(root)
	if err != nil { return "", err }
	path = filepath.Join(root, filepath.Base(path))
	info, err := os.Lstat(path)
	if os.IsNotExist(err) { return path, nil } // Allows deleting stale database records.
	if err != nil { return "", err }
	if !info.Mode().IsRegular() { return "", errors.New("package is not a regular file") }
	return path, nil
}

func (s *Server) servePackage(w http.ResponseWriter, r *http.Request, pkg *db.PackageRecord, filename string) {
	path, err := s.packagePath(pkg.FilePath)
	if err != nil { respondError(w, 404, "package file unavailable"); return }
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() { respondError(w, 404, "package file unavailable"); return }
	file, err := os.Open(path)
	if err != nil { respondError(w, 404, "package file unavailable"); return }
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) { respondError(w, 404, "package file unavailable"); return }
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(filename)}))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	http.ServeContent(w, r, filename, info.ModTime(), file)
}

func (s *Server) handlePackageDownload(w http.ResponseWriter, r *http.Request) {
	pkg, err := s.db.GetPackage(r.Context(), chi.URLParam(r, "id"))
	if err != nil { respondError(w, 404, "package not found"); return }
	s.servePackage(w, r, pkg, filepath.Base(pkg.FilePath))
}

func (s *Server) handleDeletePackage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	pkg, err := s.db.GetPackage(r.Context(), id)
	if err != nil { respondError(w, 404, "package not found"); return }
	path, err := s.packagePath(pkg.FilePath)
	if err != nil { respondError(w, 409, "package path requires administrator review"); return }
	if err := s.db.DeletePackage(r.Context(), id); err != nil { respondError(w, 500, "failed to delete package"); return }
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		s.logger.Error("package file cleanup failed", "package_id", id, "error", err)
		respondOK(w, map[string]string{"status": "deleted", "warning": "Record deleted; file cleanup requires administrator review"})
		return
	}
	respondOK(w, map[string]string{"status": "deleted"})
}
