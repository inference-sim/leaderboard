package blisrun

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
	"github.com/inference-sim/leaderboard/internal/traceingest"
)

// TestRunReplaysATrace is hermetic: a stub binary stands in for blis and writes a known
// metrics file, so the test exercises Run's replay branch and record-building without the
// simulator. It pins that a trace workload runs `blis replay`, resolves the trace from the
// store, and carries its display/provenance (trace_meta) onto a schema-valid record.
func TestRunReplaysATrace(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "blis-stub.sh")
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncat > \"$last\" <<'JSON'\n" + blisOutput + "\nJSON\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}

	// Ingest a small trace so the store holds its blob and we learn its real sha.
	store := traceingest.Store(filepath.Join(dir, "traces"))
	hPath := filepath.Join(dir, "in.yaml")
	dPath := filepath.Join(dir, "in.csv")
	_ = os.WriteFile(hPath, []byte("trace_version: 3\ntime_unit: microseconds\nmode: generated\nwarm_up_requests: 0\nsession_context_growth: accumulate\n"), 0o644)
	_ = os.WriteFile(dPath, []byte("request_id,session_id,round_index,input_tokens,output_tokens,arrival_time_us\n0,aaaa,0,418,20,0\n1,aaaa,1,50213,146,64000\n"), 0o644)
	ing, err := traceingest.IngestTraceV2(store, hPath, dPath)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}

	r := &Runner{Binary: stub, Cwd: dir, TraceStore: store, commit: "abcdef1", binarySHA256: "0123456789abcdef"}

	g := schema.Group{
		Seed: 42, RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type:           "trace",
			ArrivalProcess: "constant", // placeholder, like the spec variant
			Load:           schema.Load{Kind: "sessions", Value: 32},
			Trace: &schema.Trace{
				SHA256:             ing.SHA256,
				SessionMode:        "closed-loop",
				ConcurrentSessions: 32,
			},
		},
	}
	d := deployment()
	meta := &schema.TraceMeta{SourceFormat: "tracev2", Records: ing.Records, Sessions: ing.Sessions, SessionContextGrowth: ing.SessionContextGrowth}

	rec, err := r.Run(g, RunSpec{RunID: "trace-run", Deployment: d, WorkloadName: "acme-jan", TraceMeta: meta}, filepath.Join(dir, "m.json"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(rec.Provenance.Argv) < 2 || rec.Provenance.Argv[1] != "replay" {
		t.Errorf("expected a `replay` argv, got %v", rec.Provenance.Argv)
	}
	if rec.TraceMeta == nil || rec.TraceMeta.Records != 2 || rec.TraceMeta.Sessions != 1 {
		t.Errorf("trace_meta not carried onto the record: %+v", rec.TraceMeta)
	}
	if !rec.Status.Complete {
		t.Errorf("a clean replay should be complete, got %+v", rec.Status)
	}
	if err := schema.ValidateRecord(rec); err != nil {
		t.Errorf("runner produced a trace record the schema rejects: %v", err)
	}
}

// A trace whose blob is absent from the store is refused before shelling out: the record
// would reference bytes that are not there.
func TestRunRefusesMissingTraceBlob(t *testing.T) {
	dir := t.TempDir()
	r := &Runner{Binary: "true", Cwd: dir, TraceStore: traceingest.Store(filepath.Join(dir, "traces")), commit: "abcdef1", binarySHA256: "0123456789abcdef"}
	g := schema.Group{
		Seed: 42, RequestTimeoutS: 300,
		Workload: schema.Workload{
			Type: "trace", ArrivalProcess: "constant", Load: schema.Load{Kind: "recorded"},
			Trace: &schema.Trace{SHA256: "deadbeef", SessionMode: "fixed"},
		},
	}
	if _, err := r.Run(g, RunSpec{RunID: "missing", Deployment: deployment()}, filepath.Join(dir, "m.json")); err == nil {
		t.Fatal("expected a refusal for a missing trace blob, got nil")
	}
}
