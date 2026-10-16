package schema

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSweepFieldsAreOptional is the §invariant guarantee for storage: sweep_id and
// sweep_label are optional top-level record fields, so a record validates with both absent
// (a single run, a runs.yaml run, every pre-existing record) and with both present (a
// sweep's cell). Promoting them into the schema must never reject an existing record.
func TestSweepFieldsAreOptional(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "schema", "testdata", "valid", "workload-spec.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := Validate(raw); err != nil {
		t.Fatalf("record without sweep fields rejected: %v", err)
	}

	var rec map[string]any
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("parse: %v", err)
	}
	rec["sweep_id"] = "swp-abc-xyz"
	rec["sweep_label"] = "H100 vs A100 as concurrency climbs"
	withSweep, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := Validate(withSweep); err != nil {
		t.Errorf("record with sweep_id/sweep_label rejected: %v", err)
	}
}

// TestSweepIDDoesNotAffectGroupID is the core invariant: sweep_id is provenance, never
// part of the comparability key. GroupID hashes only the Group block (canon.go), and
// sweep_id/sweep_label live at the record top level, siblings of run_id — so two sweeps
// over the same workload produce the identical group_id, and one workload stays one table.
func TestSweepIDDoesNotAffectGroupID(t *testing.T) {
	g := fixtureGroup()
	base, err := GroupID(g)
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}

	// Two sweeps' cells over this one workload carry the same Group and differ only in the
	// top-level sweep_id/sweep_label; their records recompute to the same group_id, because
	// the hash is taken over Group alone — the top-level fields are invisible to it.
	one := Record{Group: g, SweepID: "swp-one"}
	two := Record{Group: g, SweepID: "swp-two"}
	idOne, err := GroupID(one.Group)
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	idTwo, err := GroupID(two.Group)
	if err != nil {
		t.Fatalf("GroupID: %v", err)
	}
	if idOne != base || idTwo != base {
		t.Fatalf("group_id changed with sweep_id: base %q, one %q, two %q — "+
			"sweep_id must never be folded into the comparability key", base, idOne, idTwo)
	}
	// Guard against the fields being silently dropped from the struct: a record that declares
	// them must actually carry them (the round-trip test proves write/read; this keeps the two
	// sweeps genuinely distinct in provenance even though their tables are one).
	if one.SweepID == two.SweepID {
		t.Fatal("the two sweeps collapsed to one sweep_id; the fixture is wrong")
	}
}

// TestRecordRoundTripsSweepFields proves the record carries the two fields through a
// marshal/unmarshal cycle (what the server writes to disk and reads back), and that an
// empty pair is omitted entirely (omitempty), so a single run is byte-for-byte unchanged.
func TestRecordRoundTripsSweepFields(t *testing.T) {
	rec := Record{
		SchemaVersion: SchemaVersion,
		RunID:         "h100-tp1",
		GroupID:       "abc123def456",
		SweepID:       "swp-m1-r2",
		SweepLabel:    "my sweep",
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Record
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.SweepID != "swp-m1-r2" || back.SweepLabel != "my sweep" {
		t.Fatalf("round trip lost sweep fields: %+v", back)
	}

	// An unset pair must not appear in the JSON at all, so a non-sweep record's canonical
	// form is unchanged from before the fields existed.
	var m map[string]any
	if err := json.Unmarshal(mustMarshal(t, Record{SchemaVersion: SchemaVersion, RunID: "solo"}), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["sweep_id"]; ok {
		t.Error("empty sweep_id was written; it must be omitempty")
	}
	if _, ok := m["sweep_label"]; ok {
		t.Error("empty sweep_label was written; it must be omitempty")
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}
