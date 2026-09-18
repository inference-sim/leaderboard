package schema

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidTestdataPasses(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "schema", "testdata", "valid", "*.json"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no valid testdata found")
	}
	for _, p := range paths {
		t.Run(filepath.Base(p), func(t *testing.T) {
			raw, err := os.ReadFile(p)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if err := Validate(raw); err != nil {
				t.Errorf("valid record rejected: %v", err)
			}
		})
	}
}

// TestInvalidTestdataFailsForTheRightReason keeps the suite honest: a record must
// be rejected by the rule it was written to trip, not by an unrelated typo.
func TestInvalidTestdataFailsForTheRightReason(t *testing.T) {
	dir := filepath.Join("..", "..", "schema", "testdata", "invalid")
	raw, err := os.ReadFile(filepath.Join(dir, "reasons.json"))
	if err != nil {
		t.Fatalf("read reasons.json: %v", err)
	}
	var reasons map[string]string
	if err := json.Unmarshal(raw, &reasons); err != nil {
		t.Fatalf("parse reasons.json: %v", err)
	}

	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	for _, p := range paths {
		name := filepath.Base(p)
		if name == "reasons.json" {
			continue
		}
		t.Run(name, func(t *testing.T) {
			want, ok := reasons[name]
			if !ok {
				t.Fatalf("%s has no entry in reasons.json", name)
			}
			body, err := os.ReadFile(p)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			err = Validate(body)
			if err == nil {
				t.Fatalf("expected rejection, got none")
			}
			if !strings.Contains(err.Error(), want) {
				t.Errorf("rejected for the wrong reason\n got: %v\nwant substring: %q", err, want)
			}
		})
	}
}

// TestFixtureValidatesAndIsSelfConsistent is the forcing function for the fixture
// migration: the committed evidence must validate against the shipped schema, and
// every record's ids must be reproducible from its own group by the Go hasher.
func TestFixtureValidatesAndIsSelfConsistent(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "prototypes", "results.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var records []json.RawMessage
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(records) != 12 {
		t.Fatalf("fixture has %d records, want 12", len(records))
	}

	groups := map[string]int{}
	for _, body := range records {
		var rec Record
		if err := json.Unmarshal(body, &rec); err != nil {
			t.Fatalf("decode record: %v", err)
		}
		t.Run(rec.RunID, func(t *testing.T) {
			if err := Validate(body); err != nil {
				t.Errorf("fixture record rejected: %v", err)
			}
			gid, err := GroupID(rec.Group)
			if err != nil {
				t.Fatalf("GroupID: %v", err)
			}
			if gid != rec.GroupID {
				t.Errorf("group_id = %q, recomputes to %q", rec.GroupID, gid)
			}
			wid, err := WorkID(rec.Group)
			if err != nil {
				t.Fatalf("WorkID: %v", err)
			}
			if wid != rec.WorkID {
				t.Errorf("work_id = %q, recomputes to %q", rec.WorkID, wid)
			}
		})
		groups[rec.GroupID]++
	}

	// After the C4 migration the horizon run is its own group: eleven rows in the
	// main table, one alone. That is what makes the fixture exercise multi-group
	// rendering.
	if got := groups["5063e40dceb2"]; got != 11 {
		t.Errorf("main group has %d records, want 11", got)
	}
	if got := groups["6beca76a8f45"]; got != 1 {
		t.Errorf("horizon group has %d records, want 1", got)
	}
}

// workload_name is an optional top-level field, so a record validates both with and
// without it — an existing record that predates the field is not retroactively invalid,
// and a spec-backed run that carries its catalog name is accepted.
func TestWorkloadNameIsOptional(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "schema", "testdata", "valid", "workload-spec.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := Validate(raw); err != nil {
		t.Fatalf("record without workload_name rejected: %v", err)
	}

	var rec map[string]any
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("parse: %v", err)
	}
	rec["workload_name"] = "chatbot"
	withName, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := Validate(withName); err != nil {
		t.Errorf("record with workload_name rejected: %v", err)
	}
}

func TestRequiredCoreNamesMatchesTheStruct(t *testing.T) {
	names, err := RequiredCoreNames()
	if err != nil {
		t.Fatalf("RequiredCoreNames: %v", err)
	}
	if len(names) != 27 {
		t.Errorf("schema declares %d required metrics, want 27", len(names))
	}
	var m Metrics
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal Metrics: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("unmarshal Metrics: %v", err)
	}
	for _, n := range names {
		if _, ok := fields[n]; !ok {
			t.Errorf("schema requires %q but schema.Metrics has no such json field", n)
		}
	}
	if len(fields) != len(names) {
		t.Errorf("schema.Metrics has %d json fields, schema requires %d", len(fields), len(names))
	}
}
