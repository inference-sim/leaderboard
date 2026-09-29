package traceingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeStub creates an executable shell stub standing in for `blis`, running the given
// script body. $@ is the convert argv, so a stub can inspect --trace-output.
func writeStub(t *testing.T, dir, body string) string {
	t.Helper()
	p := filepath.Join(dir, "blis-stub.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// prefixFinder is the shell that pulls the --trace-output value out of the argv, shared
// by the stubs below.
const prefixFinder = `prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--trace-output" ]; then shift; prefix="$1"; fi
  shift
done
`

// A convert that exits 0 but writes only the header (no data CSV) must fail with a clear
// message naming the conversion, not a cryptic read error on an internal temp path.
func TestIngestConvertMissingCSVIsClear(t *testing.T) {
	dir := t.TempDir()
	stub := writeStub(t, dir, prefixFinder+`printf 'trace_version: 3\n' > "$prefix.yaml"
# deliberately writes no "$prefix.csv"
exit 0
`)
	input := filepath.Join(dir, "in.jsonl")
	_ = os.WriteFile(input, []byte("{}\n"), 0o644)
	store := Store(filepath.Join(dir, "traces"))

	_, err := Ingest(store, dir, stub, Request{SourceFormat: "weka", InputPath: input})
	if err == nil {
		t.Fatal("expected an error when convert produced no CSV, got nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "convert") || !strings.Contains(msg, "weka") {
		t.Errorf("error should name the failed weka conversion, got: %v", msg)
	}
	if strings.Contains(msg, "no such file") {
		t.Errorf("error leaks a raw read failure instead of a clear message: %v", msg)
	}
}

// A convert that produces both files ingests normally through the same path.
func TestIngestConvertProducesTrace(t *testing.T) {
	dir := t.TempDir()
	stub := writeStub(t, dir, prefixFinder+`printf 'trace_version: 3\ntime_unit: microseconds\nmode: generated\nwarm_up_requests: 0\n' > "$prefix.yaml"
printf 'request_id,session_id,input_tokens,output_tokens,arrival_time_us\n0,s1,10,5,0\n' > "$prefix.csv"
exit 0
`)
	input := filepath.Join(dir, "spans.json")
	_ = os.WriteFile(input, []byte("{}\n"), 0o644)
	store := Store(filepath.Join(dir, "traces"))

	res, err := Ingest(store, dir, stub, Request{SourceFormat: "otel", InputPath: input})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Records != 1 || res.SourceFormat != "otel" {
		t.Errorf("ingest result = %+v, want 1 record, source otel", res)
	}
	if !store.Has(res.SHA256) {
		t.Error("converted trace not stored")
	}
}
