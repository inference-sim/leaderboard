package traceingest

import "testing"

const recHeader = `trace_version: 3
time_unit: microseconds
session_context_growth: accumulate
`

const recData = `request_id,session_id,input_tokens,streaming,think_time_us
r0,A,418,false,
r1,A,50213,true,0
r2,B,1088,false,240000
`

func TestRecordsFromFiles(t *testing.T) {
	recs, err := RecordsFromFiles([]byte(recHeader), []byte(recData), 0)
	if err != nil {
		t.Fatalf("RecordsFromFiles: %v", err)
	}
	if recs.TotalRecords != 3 {
		t.Errorf("total = %d, want 3", recs.TotalRecords)
	}
	if recs.Limit != defaultRecordLimit {
		t.Errorf("limit = %d, want default %d", recs.Limit, defaultRecordLimit)
	}
	if len(recs.Records) != 3 {
		t.Fatalf("records returned = %d, want 3", len(recs.Records))
	}

	// Header is parsed from YAML.
	if recs.Header["trace_version"] != 3 {
		t.Errorf("header trace_version = %v, want 3", recs.Header["trace_version"])
	}

	// Cells are JSON-typed: a number stays a number, a bool a bool.
	r0 := recs.Records[0]
	if r0["input_tokens"] != int64(418) {
		t.Errorf("r0 input_tokens = %v (%T), want int64 418", r0["input_tokens"], r0["input_tokens"])
	}
	if r0["streaming"] != false {
		t.Errorf("r0 streaming = %v, want false", r0["streaming"])
	}
	// An empty cell is omitted (r0 has no think time).
	if _, ok := r0["think_time_us"]; ok {
		t.Errorf("r0 should omit the empty think_time_us, got %v", r0["think_time_us"])
	}
	// A populated think time is present on r2.
	if recs.Records[2]["think_time_us"] != int64(240000) {
		t.Errorf("r2 think_time_us = %v, want 240000", recs.Records[2]["think_time_us"])
	}
}

func TestRecordsFromFilesLimit(t *testing.T) {
	// A limit smaller than the corpus caps the sample but still counts every record.
	recs, err := RecordsFromFiles([]byte(recHeader), []byte(recData), 1)
	if err != nil {
		t.Fatalf("RecordsFromFiles: %v", err)
	}
	if len(recs.Records) != 1 {
		t.Errorf("records returned = %d, want 1 (the limit)", len(recs.Records))
	}
	if recs.TotalRecords != 3 {
		t.Errorf("total = %d, want 3 (the whole corpus)", recs.TotalRecords)
	}
}

func TestRecordsFromFilesCaps(t *testing.T) {
	// A limit above the hard cap is clamped.
	recs, err := RecordsFromFiles([]byte(recHeader), []byte(recData), maxRecordLimit+1000)
	if err != nil {
		t.Fatalf("RecordsFromFiles: %v", err)
	}
	if recs.Limit != maxRecordLimit {
		t.Errorf("limit = %d, want capped at %d", recs.Limit, maxRecordLimit)
	}
}
