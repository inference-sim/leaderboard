package traceingest

import (
	"os"
	"path/filepath"
	"testing"
)

const sampleHeader = `trace_version: 3
time_unit: microseconds
mode: generated
warm_up_requests: 0
session_context_growth: accumulate
`

// Two rows for session A, one for session B: 3 records, 2 distinct sessions.
const sampleCSV = `request_id,client_id,tenant_id,slo_class,session_id,round_index,input_tokens,output_tokens,arrival_time_us
0,,,,aaaa,0,418,20,0
1,,,,aaaa,1,50213,146,64000
2,,,,bbbb,0,900,30,10000
`

func writeTraceV2(t *testing.T, dir, header, csv string) (string, string) {
	t.Helper()
	h := filepath.Join(dir, "in.yaml")
	d := filepath.Join(dir, "in.csv")
	if err := os.WriteFile(h, []byte(header), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d, []byte(csv), 0o644); err != nil {
		t.Fatal(err)
	}
	return h, d
}

func TestIngestTraceV2WritesBlobAndReportsCorpus(t *testing.T) {
	tmp := t.TempDir()
	h, d := writeTraceV2(t, tmp, sampleHeader, sampleCSV)
	store := Store(filepath.Join(tmp, "traces"))

	res, err := IngestTraceV2(store, h, d)
	if err != nil {
		t.Fatalf("IngestTraceV2: %v", err)
	}
	if res.SHA256 == "" {
		t.Fatal("empty sha256")
	}
	if res.Records != 3 {
		t.Errorf("Records = %d, want 3", res.Records)
	}
	if res.Sessions != 2 {
		t.Errorf("Sessions = %d, want 2", res.Sessions)
	}
	if res.SessionContextGrowth != "accumulate" {
		t.Errorf("SessionContextGrowth = %q, want accumulate", res.SessionContextGrowth)
	}
	if res.SourceFormat != "tracev2" {
		t.Errorf("SourceFormat = %q, want tracev2", res.SourceFormat)
	}
	// The blob is written under the hash, and the bytes round-trip.
	hp, _ := store.Paths(res.SHA256)
	gotH, err := os.ReadFile(hp)
	if err != nil {
		t.Fatalf("read stored header: %v", err)
	}
	if string(gotH) != sampleHeader {
		t.Errorf("stored header differs from input")
	}
	if !store.Has(res.SHA256) {
		t.Error("Has() false for a just-written blob")
	}
}

// The hash is over the content, so identical bytes ingest to the same sha (and the second
// write is a no-op), while different data yields a different sha.
func TestIngestTraceV2HashIsContentAddressed(t *testing.T) {
	tmp := t.TempDir()
	store := Store(filepath.Join(tmp, "traces"))

	h1, d1 := writeTraceV2(t, t.TempDir(), sampleHeader, sampleCSV)
	a, err := IngestTraceV2(store, h1, d1)
	if err != nil {
		t.Fatal(err)
	}
	h2, d2 := writeTraceV2(t, t.TempDir(), sampleHeader, sampleCSV)
	b, err := IngestTraceV2(store, h2, d2)
	if err != nil {
		t.Fatal(err)
	}
	if a.SHA256 != b.SHA256 {
		t.Errorf("identical content hashed to %q and %q", a.SHA256, b.SHA256)
	}

	h3, d3 := writeTraceV2(t, t.TempDir(), sampleHeader, sampleCSV+"3,,,,cccc,0,10,5,20000\n")
	c, err := IngestTraceV2(store, h3, d3)
	if err != nil {
		t.Fatal(err)
	}
	if c.SHA256 == a.SHA256 {
		t.Error("different data hashed to the same sha")
	}
}

// A trace whose source run spanned more than one node cannot be reproduced by replay, so
// ingest refuses it up front rather than storing a blob that would replay too fast.
func TestIngestTraceV2RefusesMultiNode(t *testing.T) {
	tmp := t.TempDir()
	store := Store(filepath.Join(tmp, "traces"))
	header := sampleHeader + "max_nodes_spanned: 2\n"
	h, d := writeTraceV2(t, tmp, header, sampleCSV)
	if _, err := IngestTraceV2(store, h, d); err == nil {
		t.Fatal("expected a refusal for a multi-node trace, got nil")
	}
}

// A non-accumulate trace with no session_id column is a single-shot corpus: 0 sessions.
func TestIngestTraceV2NoSessionColumn(t *testing.T) {
	tmp := t.TempDir()
	store := Store(filepath.Join(tmp, "traces"))
	header := "trace_version: 3\ntime_unit: microseconds\nmode: generated\nwarm_up_requests: 0\n"
	csv := "request_id,input_tokens,output_tokens,arrival_time_us\n0,100,20,0\n1,200,30,5000\n"
	h, d := writeTraceV2(t, tmp, header, csv)
	res, err := IngestTraceV2(store, h, d)
	if err != nil {
		t.Fatal(err)
	}
	if res.Records != 2 || res.Sessions != 0 {
		t.Errorf("Records/Sessions = %d/%d, want 2/0", res.Records, res.Sessions)
	}
	if res.SessionContextGrowth != "" {
		t.Errorf("SessionContextGrowth = %q, want empty", res.SessionContextGrowth)
	}
}
