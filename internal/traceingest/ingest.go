// Package traceingest turns a trace a user brings — a native TraceV2 pair, or a raw
// OTel/Weka file converted with `blis convert` — into a content-addressed blob in the
// store beside the workload catalog, and reports what a "trace" workload profile needs to
// describe it: the content hash, the corpus size, and the trace's session_context_growth.
//
// The pure, hermetic core (hashing, the store, header/CSV inspection, IngestTraceV2) is
// here; the `blis convert` shell-out is in convert.go so tests exercise ingest without a
// binary.
package traceingest

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Store is the root of the hash-addressed trace store: the traces/ directory beside the
// workload catalog. A trace lives at <root>/<sha256>/{header.yaml,data.csv}.
type Store string

// Paths returns the absolute header and data paths for a trace hash. They are absolute
// because blis replay resolves --trace-header/--trace-data relative to its own cwd
// (../inference-sim), not the leaderboard's.
func (s Store) Paths(sha string) (header, data string) {
	dir := filepath.Join(string(s), sha)
	h, _ := filepath.Abs(filepath.Join(dir, "header.yaml"))
	d, _ := filepath.Abs(filepath.Join(dir, "data.csv"))
	return h, d
}

// Has reports whether both files of a trace are present in the store.
func (s Store) Has(sha string) bool {
	h, d := s.Paths(sha)
	if _, err := os.Stat(h); err != nil {
		return false
	}
	_, err := os.Stat(d)
	return err == nil
}

// Result is what ingest reports for a stored trace: enough to write a "trace" workload
// profile (schema.Trace.SHA256 plus the TraceMeta display/provenance).
type Result struct {
	SHA256               string
	Records              int
	Sessions             int
	SessionContextGrowth string
	SourceFormat         string
}

// header is the subset of the TraceV2 header the leaderboard reads: growth decides which
// session modes are valid, and a span above 1 means replay cannot reproduce the trace.
type traceHeaderFields struct {
	SessionContextGrowth string `yaml:"session_context_growth"`
	MaxNodesSpanned      int    `yaml:"max_nodes_spanned"`
}

// IngestTraceV2 stores a native TraceV2 pair by content hash and reports its corpus. It
// refuses a trace whose source run spanned more than one node: replay cannot reconstruct
// a multi-node fleet, so it would reproduce the workload at single-node speed (the same
// refusal blis replay makes, made here before a blob is stored).
func IngestTraceV2(store Store, headerPath, dataPath string) (Result, error) {
	headerBytes, err := os.ReadFile(headerPath)
	if err != nil {
		return Result{}, fmt.Errorf("read trace header %s: %w", headerPath, err)
	}
	dataBytes, err := os.ReadFile(dataPath)
	if err != nil {
		return Result{}, fmt.Errorf("read trace data %s: %w", dataPath, err)
	}

	var hf traceHeaderFields
	if err := yaml.Unmarshal(headerBytes, &hf); err != nil {
		return Result{}, fmt.Errorf("parse trace header %s: %w", headerPath, err)
	}
	if hf.MaxNodesSpanned > 1 {
		return Result{}, fmt.Errorf(
			"this trace's source run placed a model instance across %d nodes "+
				"(max_nodes_spanned=%d); blis replay cannot reproduce a multi-node fleet, so it "+
				"would replay the workload at single-node speed. Re-record it on a single node.",
			hf.MaxNodesSpanned, hf.MaxNodesSpanned)
	}

	records, sessions, err := inspectCSV(dataBytes)
	if err != nil {
		return Result{}, fmt.Errorf("read trace data %s: %w", dataPath, err)
	}

	sha := hashTrace(headerBytes, dataBytes)
	if err := store.write(sha, headerBytes, dataBytes); err != nil {
		return Result{}, err
	}

	return Result{
		SHA256:               sha,
		Records:              records,
		Sessions:             sessions,
		SessionContextGrowth: hf.SessionContextGrowth,
		SourceFormat:         "tracev2",
	}, nil
}

// hashTrace is the content id of a replayable TraceV2: the full sha256 of the header
// bytes followed by the data bytes. The full digest (not a short id) because it backs
// group_id, where a collision would merge two traces into one table.
func hashTrace(header, data []byte) string {
	h := sha256.New()
	h.Write(header)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// write stores the two files under the hash. It is idempotent: a blob already present
// (same hash, therefore same bytes) is left untouched.
func (s Store) write(sha string, header, data []byte) error {
	dir := filepath.Join(string(s), sha)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create trace store dir %s: %w", dir, err)
	}
	for name, body := range map[string][]byte{"header.yaml": header, "data.csv": data} {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			continue // content-addressed: identical bytes already there
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			return fmt.Errorf("write trace file %s: %w", p, err)
		}
	}
	return nil
}

// inspectCSV counts data rows and distinct session_ids. The session_id column is located
// by name from the header row, so a single-shot corpus (no such column) reports 0
// sessions rather than failing.
func inspectCSV(data []byte) (records, sessions int, err error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1 // trace CSVs are wide and may vary; do not enforce a column count
	head, err := r.Read()
	if err == io.EOF {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("parse CSV header: %w", err)
	}
	sessionCol := -1
	for i, name := range head {
		if name == "session_id" {
			sessionCol = i
			break
		}
	}
	seen := map[string]struct{}{}
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, 0, fmt.Errorf("parse CSV row %d: %w", records+1, err)
		}
		records++
		if sessionCol >= 0 && sessionCol < len(row) && row[sessionCol] != "" {
			seen[row[sessionCol]] = struct{}{}
		}
	}
	return records, len(seen), nil
}
