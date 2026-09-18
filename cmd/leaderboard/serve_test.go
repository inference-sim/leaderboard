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
