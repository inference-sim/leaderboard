package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// sampleRecord is a minimal valid-enough record for the handler paths that do not
// touch blis: the handler only reads GroupID and RunID to file it.
func sampleRecord(runID, groupID string) schema.Record {
	return schema.Record{
		SchemaVersion: schema.SchemaVersion,
		RunID:         runID,
		GroupID:       groupID,
		Group:         schema.Group{},
		Deployment:    schema.Deployment{Model: "qwen/qwen3-14b", Hardware: "H100", TP: 1},
	}
}

func TestHandleRunWritesAndReturns(t *testing.T) {
	out := t.TempDir()
	var gotDep schema.Deployment
	var gotRunID, gotName string
	s := &server{
		outDir: out,
		execute: func(g schema.Group, runID string, dep schema.Deployment, workloadName string) (schema.Record, error) {
			gotDep, gotRunID, gotName = dep, runID, workloadName
			rec := sampleRecord(runID, "abc123")
			rec.WorkloadName = workloadName
			return rec, nil
		},
	}

	body, _ := json.Marshal(runRequest{
		Group:        schema.Group{},
		Deployment:   schema.Deployment{Model: "qwen/qwen3-14b", Hardware: "H100", TP: 1},
		RunID:        "h100-tp1",
		WorkloadName: "chatbot",
	})
	rr := httptest.NewRecorder()
	s.handleRun(rr, httptest.NewRequest(http.MethodPost, "/api/run", bytes.NewReader(body)))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	if gotRunID != "h100-tp1" || gotDep.Model != "qwen/qwen3-14b" {
		t.Fatalf("executor got run_id %q deployment %+v", gotRunID, gotDep)
	}
	if gotName != "chatbot" {
		t.Fatalf("executor got workload_name %q, want chatbot", gotName)
	}

	// The result must land where `leaderboard run` would put it.
	written := filepath.Join(out, "abc123", "h100-tp1.json")
	if _, err := os.Stat(written); err != nil {
		t.Fatalf("expected %s to exist: %v", written, err)
	}
	var rec schema.Record
	if err := json.Unmarshal(rr.Body.Bytes(), &rec); err != nil {
		t.Fatalf("response is not a record: %v", err)
	}
	if rec.RunID != "h100-tp1" {
		t.Fatalf("response run_id = %q", rec.RunID)
	}
	if rec.WorkloadName != "chatbot" {
		t.Fatalf("response workload_name = %q, want chatbot", rec.WorkloadName)
	}
}

func TestHandleRunRejectsBadRunID(t *testing.T) {
	called := false
	s := &server{
		outDir: t.TempDir(),
		execute: func(schema.Group, string, schema.Deployment, string) (schema.Record, error) {
			called = true
			return schema.Record{}, nil
		},
	}
	body, _ := json.Marshal(runRequest{RunID: "../escape"})
	rr := httptest.NewRecorder()
	s.handleRun(rr, httptest.NewRequest(http.MethodPost, "/api/run", bytes.NewReader(body)))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if called {
		t.Fatal("executor ran despite an invalid run_id")
	}
}

func TestHandleRunSurfacesExecutorError(t *testing.T) {
	s := &server{
		outDir: t.TempDir(),
		execute: func(schema.Group, string, schema.Deployment, string) (schema.Record, error) {
			return schema.Record{}, os.ErrPermission
		},
	}
	body, _ := json.Marshal(runRequest{RunID: "ok", Deployment: schema.Deployment{Hardware: "H100", TP: 1}})
	rr := httptest.NewRecorder()
	s.handleRun(rr, httptest.NewRequest(http.MethodPost, "/api/run", bytes.NewReader(body)))

	if rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rr.Code)
	}
	var payload map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil || payload["error"] == "" {
		t.Fatalf("want {error} body, got %s", rr.Body.String())
	}
}

// deleteRequest builds a DELETE /api/results/{group}/{run} request with its path values
// set, so handleResultDelete can be exercised without wiring the whole mux.
func deleteRequest(group, run string) *http.Request {
	req := httptest.NewRequest(http.MethodDelete, "/api/results/"+group+"/"+run, nil)
	req.SetPathValue("group", group)
	req.SetPathValue("run", run)
	return req
}

func TestHandleResultDeleteRemovesRecordAndSidecar(t *testing.T) {
	out := t.TempDir()
	groupDir := filepath.Join(out, "g1")
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// The run to delete, its sidecar, and a second run that must survive.
	for _, name := range []string{"r1.json", "r1.requests.json", "r2.json"} {
		if err := os.WriteFile(filepath.Join(groupDir, name), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	s := &server{outDir: out}
	rr := httptest.NewRecorder()
	s.handleResultDelete(rr, deleteRequest("g1", "r1"))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil || payload["deleted"] != "r1" {
		t.Fatalf("want {deleted:r1}, got %s", rr.Body.String())
	}
	for _, gone := range []string{"r1.json", "r1.requests.json"} {
		if _, err := os.Stat(filepath.Join(groupDir, gone)); !os.IsNotExist(err) {
			t.Fatalf("expected %s to be gone, stat err = %v", gone, err)
		}
	}
	if _, err := os.Stat(filepath.Join(groupDir, "r2.json")); err != nil {
		t.Fatalf("r2.json should survive the delete: %v", err)
	}
}

func TestHandleResultDeleteWithoutSidecarSucceeds(t *testing.T) {
	out := t.TempDir()
	groupDir := filepath.Join(out, "g1")
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(groupDir, "r1.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &server{outDir: out}
	rr := httptest.NewRecorder()
	s.handleResultDelete(rr, deleteRequest("g1", "r1"))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(groupDir, "r1.json")); !os.IsNotExist(err) {
		t.Fatalf("expected r1.json gone, stat err = %v", err)
	}
}

func TestResultDeleteRouteExtractsGroupAndRun(t *testing.T) {
	// Through the real mux, so the DELETE /api/results/{group}/{run} pattern and its
	// PathValue names are exercised — not just the handler in isolation.
	out := t.TempDir()
	groupDir := filepath.Join(out, "abc123")
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(groupDir, "h100-tp1.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &server{outDir: out}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/api/results/abc123/h100-tp1", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(groupDir, "h100-tp1.json")); !os.IsNotExist(err) {
		t.Fatalf("expected the record deleted, stat err = %v", err)
	}
	// A GET on the same path is not the delete route, so it must not delete.
	if got := methodStatus(s, http.MethodGet, "/api/results/abc123/h100-tp1"); got == http.StatusOK {
		t.Fatal("GET on the delete path should not succeed as a delete")
	}
}

// methodStatus runs one request through the mux and returns its status, for asserting that
// a path answers (or does not) for a given method.
func methodStatus(s *server, method, target string) int {
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(method, target, nil))
	return rr.Code
}

func TestHandleResultDeleteMissingRunIs404(t *testing.T) {
	s := &server{outDir: t.TempDir()}
	rr := httptest.NewRecorder()
	s.handleResultDelete(rr, deleteRequest("g1", "nope"))

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestHandleResultDeleteRejectsBadSegments(t *testing.T) {
	// Segments that would escape the results tree or are otherwise malformed are
	// refused before any file is touched.
	cases := []struct{ group, run string }{
		{"g1", "../escape"},
		{"g1", "R1"},  // upper-case is not a valid run_id
		{"..", "r1"},  // group traversal
		{"g_1", "r1"}, // underscore is not hex, not a group_id
		{"", "r1"},    // empty group
	}
	for _, c := range cases {
		s := &server{outDir: t.TempDir()}
		rr := httptest.NewRecorder()
		s.handleResultDelete(rr, deleteRequest(c.group, c.run))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("group=%q run=%q: status = %d, want 400", c.group, c.run, rr.Code)
		}
	}
}

func TestReadResultsSkipsSidecarsAndMissingDir(t *testing.T) {
	// Missing directory is the empty state, not an error.
	got, err := readResults(filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(got) != 0 {
		t.Fatalf("missing dir: got %v, %v", got, err)
	}

	out := t.TempDir()
	groupDir := filepath.Join(out, "g1")
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rec := sampleRecord("r1", "g1")
	body, _ := json.MarshalIndent(rec, "", " ")
	if err := os.WriteFile(filepath.Join(groupDir, "r1.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// A sidecar must be ignored: it is not a record.
	if err := os.WriteFile(filepath.Join(groupDir, "r1.requests.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err = readResults(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].RunID != "r1" {
		t.Fatalf("want one record r1, got %+v", got)
	}
}
