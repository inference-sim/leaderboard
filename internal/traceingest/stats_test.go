package traceingest

import "testing"

// A small trace CSV: two sessions (A with three turns, B with one), with the token, arrival,
// and think-time columns the stats read. The first turn of each session has no think time
// (empty), mirroring a real TraceV2.
const statsSampleCSV = `request_id,session_id,input_tokens,output_tokens,arrival_time_us,think_time_us
r0,A,100,10,0,
r1,A,200,20,64000,0
r2,A,300,30,128000,240000
r3,B,400,40,0,
`

func sumBins(h Histogram) int {
	n := 0
	for _, b := range h.Bins {
		n += b.Count
	}
	return n
}

func TestStatsFromCSV(t *testing.T) {
	s, err := StatsFromCSV([]byte(statsSampleCSV))
	if err != nil {
		t.Fatalf("StatsFromCSV: %v", err)
	}

	if s.Records != 4 {
		t.Errorf("records = %d, want 4", s.Records)
	}
	if s.Sessions != 2 {
		t.Errorf("sessions = %d, want 2", s.Sessions)
	}

	if s.InputTokens.Count != 4 || s.InputTokens.Min != 100 || s.InputTokens.Max != 400 {
		t.Errorf("input tokens = %+v, want count 4 min 100 max 400", s.InputTokens)
	}
	if s.OutputTokens.Count != 4 || s.OutputTokens.Min != 10 || s.OutputTokens.Max != 40 {
		t.Errorf("output tokens = %+v, want count 4 min 10 max 40", s.OutputTokens)
	}

	// Turns per session: A has 3, B has 1.
	if s.TurnsPerSession.Count != 2 || s.TurnsPerSession.Min != 1 || s.TurnsPerSession.Max != 3 {
		t.Errorf("turns = %+v, want count 2 min 1 max 3", s.TurnsPerSession)
	}

	// Think time: only the two non-empty cells count (0 ms and 240 ms); the first turn of
	// each session is skipped.
	if s.ThinkTimeMs.Count != 2 || s.ThinkTimeMs.Max != 240 {
		t.Errorf("think time = %+v, want count 2 max 240", s.ThinkTimeMs)
	}

	// Arrival timeline spans 0..128000us = 128ms across the four requests.
	if s.Arrival.Count != 4 || s.Arrival.SpanMs != 128 {
		t.Errorf("arrival = count %d span %v, want count 4 span 128", s.Arrival.Count, s.Arrival.SpanMs)
	}

	// Every value lands in exactly one bin.
	for name, h := range map[string]Histogram{
		"input": s.InputTokens, "output": s.OutputTokens, "turns": s.TurnsPerSession, "think": s.ThinkTimeMs,
	} {
		if got := sumBins(h); got != h.Count {
			t.Errorf("%s: bins sum to %d, want %d", name, got, h.Count)
		}
	}
	arrivalInBuckets := 0
	for _, b := range s.Arrival.Buckets {
		arrivalInBuckets += b.Count
	}
	if arrivalInBuckets != s.Arrival.Count {
		t.Errorf("arrival buckets sum to %d, want %d", arrivalInBuckets, s.Arrival.Count)
	}
}

func TestStatsFromCSVEmpty(t *testing.T) {
	s, err := StatsFromCSV([]byte("request_id,session_id,input_tokens\n"))
	if err != nil {
		t.Fatalf("StatsFromCSV: %v", err)
	}
	if s.Records != 0 || s.Sessions != 0 {
		t.Errorf("empty body: records %d sessions %d, want 0 0", s.Records, s.Sessions)
	}
	if s.InputTokens.Count != 0 || len(s.InputTokens.Bins) != 0 {
		t.Errorf("empty body: input tokens = %+v, want no data", s.InputTokens)
	}
}

func TestStatsFromCSVMissingColumns(t *testing.T) {
	// A trace lacking the token/timing columns still counts records and sessions, and reports
	// empty distributions for the absent columns rather than failing.
	s, err := StatsFromCSV([]byte("request_id,session_id\nr0,A\nr1,A\nr2,B\n"))
	if err != nil {
		t.Fatalf("StatsFromCSV: %v", err)
	}
	if s.Records != 3 || s.Sessions != 2 {
		t.Errorf("records %d sessions %d, want 3 2", s.Records, s.Sessions)
	}
	if s.InputTokens.Count != 0 || s.Arrival.Count != 0 || s.ThinkTimeMs.Count != 0 {
		t.Errorf("absent columns should yield empty distributions, got %+v", s)
	}
	// Turns are still computable from session_id alone: A has 2, B has 1.
	if s.TurnsPerSession.Count != 2 || s.TurnsPerSession.Max != 2 {
		t.Errorf("turns = %+v, want count 2 max 2", s.TurnsPerSession)
	}
}
