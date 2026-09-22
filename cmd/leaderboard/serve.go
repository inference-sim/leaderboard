package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/inference-sim/leaderboard/internal/blisrun"
	"github.com/inference-sim/leaderboard/internal/hardware"
	"github.com/inference-sim/leaderboard/internal/schema"
)

// serveRunIDPattern mirrors internal/spec.runIDPattern. A run_id is also a
// filename, so an id that does not match could write outside the group directory;
// the server rejects it before anything runs.
var serveRunIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// serveGroupIDPattern matches a group_id — a hex content hash (internal/schema.GroupID),
// so lower-case letters and digits only. A group_id is a directory name under results/,
// so this rejects a "." / ".." / slash that could point delete outside the results tree.
var serveGroupIDPattern = regexp.MustCompile(`^[a-z0-9]+$`)

// runRequest is the body the Declare-a-run screen POSTs to /api/run: the work
// offered, the candidate under test, and the id the result is filed under. It is
// the same three things a runs.yaml carries, decoded straight into the record
// types so the field names cannot drift from what is written to disk.
type runRequest struct {
	Group      schema.Group      `json:"group"`
	Deployment schema.Deployment `json:"deployment"`
	RunID      string            `json:"run_id"`
	// WorkloadName is the catalog name the workload was chosen by (a preset or saved
	// profile), stored on the record for display. Empty for the custom card, which
	// names no profile.
	WorkloadName string `json:"workload_name"`
}

// server holds what the HTTP handlers need. execute and validateSpec are fields so the
// handlers can be tested without a blis binary: production wires them to runOnce and
// the runner's spec smoke run, and tests substitute stubs.
type server struct {
	outDir      string
	blisDir     string
	catalogPath string
	execute     func(g schema.Group, runID string, dep schema.Deployment, workloadName string) (schema.Record, error)
	// validateSpec hands a raw inline WorkloadSpec to blis to surface its own parse and
	// semantic errors (§5). nil error means blis accepts it.
	validateSpec func(spec map[string]any) error
	// catMu serialises the read-modify-write of workloads.yaml across requests.
	catMu sync.Mutex
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	c.bind(fs)
	addr := fs.String("addr", ":8080", "address to listen on")
	catalogPath := fs.String("workloads", "", "path to the workload catalog (default <out>/workloads.yaml)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// The catalog is a local artifact, so by default it lives alongside the results
	// rather than at the repo root — <out>/workloads.yaml.
	catPath := *catalogPath
	if catPath == "" {
		catPath = filepath.Join(c.outDir, "workloads.yaml")
	}

	s := &server{outDir: c.outDir, blisDir: c.blisDir, catalogPath: catPath}
	s.execute = s.runOnce
	s.validateSpec = s.validateSpecWithBlis

	fmt.Printf("leaderboard serve — http://localhost%s  (blis: %s, results: %s)\n",
		*addr, c.blisDir, c.outDir)
	return http.ListenAndServe(*addr, withCORS(s.routes()))
}

// routes wires every handler onto a mux. It is a method so the routing — the method+path
// patterns and their PathValue names — can be exercised end to end in a test, not only by
// calling handlers directly.
func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/api/results", s.handleResults)
	// Deleting one stored run. A longer path than /api/results, so the two do not
	// collide; the method+path pattern needs Go 1.22's ServeMux, same as the workload routes.
	mux.HandleFunc("DELETE /api/results/{group}/{run}", s.handleResultDelete)
	s.registerWorkloadRoutes(mux)
	// Serve the built web app when it exists, so `leaderboard serve` is the whole
	// thing in one process. In development the Vite dev server proxies /api here
	// instead, and this static handler is never reached.
	mux.Handle("/", spaHandler("web/dist"))
	return mux
}

// handleRun executes one candidate against blis, writes the result under
// results/<group_id>/<run_id>.json exactly as `leaderboard run` does, and returns
// the record. The browser could not do any of this itself — blis resolves its
// config files relative to the upstream checkout — so the work happens here.
func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, http.StatusMethodNotAllowed, "POST a run declaration to this endpoint")
		return
	}
	var req runRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, fmt.Sprintf("could not read the declaration: %v", err))
		return
	}
	if !serveRunIDPattern.MatchString(req.RunID) {
		httpError(w, http.StatusBadRequest,
			fmt.Sprintf("run_id %q must be lower-case letters, digits, dot, dash or underscore, "+
				"starting with a letter or digit — it becomes a filename", req.RunID))
		return
	}

	rec, err := s.execute(req.Group, req.RunID, req.Deployment, req.WorkloadName)
	if err != nil {
		// A blis failure is the caller's to read, not a server fault: the flags it
		// declared produced it. Surface the message so the screen can show it.
		httpError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	if err := s.writeResult(rec); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// handleResults returns every stored record so the leaderboard reflects runs made
// this session without a rebuild. It reads the same files the committed build
// inlines; the shapes are identical, so the page merges the two without caring
// which is which.
func (s *server) handleResults(w http.ResponseWriter, r *http.Request) {
	records, err := readResults(s.outDir)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, records)
}

// handleResultDelete removes one stored run — results/<group>/<run>.json — and its
// optional <run>.requests.json sidecar (written by CLI runs with --keep-requests). It is
// the browser counterpart to deleting the file by hand: a run declared from the board can
// also be taken off it from the board, without a rebuild. Both path segments are validated
// before anything is touched, so a crafted id cannot delete outside the results tree.
func (s *server) handleResultDelete(w http.ResponseWriter, r *http.Request) {
	group := r.PathValue("group")
	run := r.PathValue("run")
	if !serveGroupIDPattern.MatchString(group) {
		httpError(w, http.StatusBadRequest,
			fmt.Sprintf("group_id %q must be lower-case letters and digits — it is a directory name", group))
		return
	}
	if !serveRunIDPattern.MatchString(run) {
		httpError(w, http.StatusBadRequest,
			fmt.Sprintf("run_id %q must be lower-case letters, digits, dot, dash or underscore, "+
				"starting with a letter or digit — it is a filename", run))
		return
	}

	record := filepath.Join(s.outDir, group, run+".json")
	if _, err := os.Stat(record); errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound,
			fmt.Sprintf("no run %q under group %q to delete", run, group))
		return
	}
	if err := os.Remove(record); err != nil {
		httpError(w, http.StatusInternalServerError, fmt.Sprintf("delete %s: %v", record, err))
		return
	}
	// The sidecar is optional, so its absence is success, not an error; only a real
	// removal failure is worth reporting.
	sidecar := filepath.Join(s.outDir, group, run+".requests.json")
	if err := os.Remove(sidecar); err != nil && !errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusInternalServerError, fmt.Sprintf("delete %s: %v", sidecar, err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": run})
}

// runOnce is the production executor: check the hardware against the upstream
// catalogue, capture fresh provenance, and run. A new Runner per request means the
// upstream commit and dirty flag on the record describe the tree as it was when the
// run happened, not when the server started.
func (s *server) runOnce(g schema.Group, runID string, dep schema.Deployment, workloadName string) (schema.Record, error) {
	cat, err := hardware.Load(filepath.Join(s.blisDir, "hardware_config.json"))
	if err != nil {
		return schema.Record{}, err
	}
	if !cat.Known(dep.Hardware) {
		return schema.Record{}, fmt.Errorf("hardware %q is not in hardware_config.json; valid names are %s",
			dep.Hardware, strings.Join(cat.Names(), ", "))
	}

	runner, err := blisrun.NewRunner(s.blisDir)
	if err != nil {
		return schema.Record{}, err
	}
	tmpDir, err := os.MkdirTemp("", "leaderboard-metrics-")
	if err != nil {
		return schema.Record{}, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	return runner.Run(g, blisrun.RunSpec{RunID: runID, Deployment: dep, WorkloadName: workloadName}, filepath.Join(tmpDir, runID+".json"))
}

// probeModel and probeHardware are the placeholders the spec smoke run uses so blis —
// which requires --model/--hardware even with --workload-spec and has no top-level
// model field — will parse and start a spec. They are only to surface the spec's own
// errors; the model actually run is chosen later, in Declare-a-run (P6). qwen/qwen3-14b
// is in the bundled blis-catalog (BLIS_CATALOG) and H100 in hardware_config.json, so the
// smoke run stays offline.
const (
	probeModel    = "qwen/qwen3-14b"
	probeHardware = "H100"
)

// validateSpecWithBlis is the production spec validator: it runs blis on the inline
// spec (design §5, the smoke-run fallback — blis has no validate subcommand) so the
// errors reported are blis's own.
func (s *server) validateSpecWithBlis(spec map[string]any) error {
	runner, err := blisrun.NewRunner(s.blisDir)
	if err != nil {
		return err
	}
	return runner.ValidateSpec(spec, probeModel, probeHardware)
}

// writeResult files a record the way `leaderboard run` does: results/<group_id>/
// <run_id>.json, indented with one space and a trailing newline, so a run made from
// the browser is byte-identical to one made from the CLI.
func (s *server) writeResult(rec schema.Record) error {
	groupDir := filepath.Join(s.outDir, rec.GroupID)
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", groupDir, err)
	}
	body, err := json.MarshalIndent(rec, "", " ")
	if err != nil {
		return fmt.Errorf("encode record: %w", err)
	}
	out := filepath.Join(groupDir, rec.RunID+".json")
	if err := os.WriteFile(out, append(body, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", out, err)
	}
	return nil
}

// readResults reads every results/<group>/<run>.json under dir, skipping the
// per-request sidecars. A missing directory is not an error: a fresh checkout has
// no results yet and the page shows its empty state.
func readResults(dir string) ([]schema.Record, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []schema.Record{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}
	records := []schema.Record{}
	for _, groupEntry := range entries {
		if !groupEntry.IsDir() {
			continue
		}
		groupDir := filepath.Join(dir, groupEntry.Name())
		files, err := os.ReadDir(groupDir)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", groupDir, err)
		}
		for _, f := range files {
			name := f.Name()
			if f.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".requests.json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(groupDir, name))
			if err != nil {
				return nil, fmt.Errorf("read %s: %w", filepath.Join(groupDir, name), err)
			}
			var rec schema.Record
			if err := json.Unmarshal(raw, &rec); err != nil {
				return nil, fmt.Errorf("decode %s: %w", filepath.Join(groupDir, name), err)
			}
			records = append(records, rec)
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].RunID < records[j].RunID })
	return records, nil
}

// spaHandler serves a static directory and falls back to index.html for unknown
// paths, so the hash-routed app loads from any URL. When the directory is absent
// (no `make web-build`), it says so rather than 404-ing blankly.
func spaHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			httpError(w, http.StatusNotFound,
				"no web/dist — run `make web-build`, or use the Vite dev server which proxies /api here")
			return
		}
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}

// withCORS lets the Vite dev server (a different origin) call the API directly if
// its proxy is not configured. Same-origin requests through the proxy are
// unaffected.
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// httpError sends {"error": msg} so the screen can render the reason a run did not
// happen, rather than a bare status code.
func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
