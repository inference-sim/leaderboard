package traceingest

// Per-record distributions of a stored trace, computed from its data.csv so the web app can
// chart a weka trace's shape — input/output token sizes, turns per session, arrival timeline,
// and think time — without shipping every record to the browser. The binning is done here,
// server-side: a real corpus is tens of thousands of records, so the client receives bin
// counts and summary stats, not raw arrays. All columns are located by name from the header
// row (like inspectCSV), so a trace missing a column yields an empty distribution for it
// rather than an error.

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"slices"
	"sort"
	"strconv"
)

// Bin is one equal-width bucket of a Histogram: [Lo, Hi) counts, except the last bin, which
// includes its upper edge so the maximum value is counted.
type Bin struct {
	Lo    float64 `json:"lo"`
	Hi    float64 `json:"hi"`
	Count int     `json:"count"`
}

// Histogram is a pre-binned numeric distribution with summary stats. Count 0 (and empty Bins)
// means the column was absent or held no numeric values, which the chart renders as "no data".
type Histogram struct {
	Bins  []Bin   `json:"bins"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Mean  float64 `json:"mean"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	Count int     `json:"count"`
}

// TimeBucket is one time slice of a Timeline: how many requests arrived in [TMs, TMs+width),
// where TMs is milliseconds from the first arrival.
type TimeBucket struct {
	TMs   float64 `json:"t_ms"`
	Count int     `json:"count"`
}

// Timeline is request arrivals binned over wall-clock time, measured from the first arrival,
// so the chart shows the recorded stream's burstiness.
type Timeline struct {
	Buckets []TimeBucket `json:"buckets"`
	SpanMs  float64      `json:"span_ms"`
	Count   int          `json:"count"`
}

// Stats is the full set of distributions for one trace, matching the web TraceStats interface.
type Stats struct {
	Records         int       `json:"records"`
	Sessions        int       `json:"sessions"`
	InputTokens     Histogram `json:"input_tokens"`
	OutputTokens    Histogram `json:"output_tokens"`
	TurnsPerSession Histogram `json:"turns_per_session"`
	ThinkTimeMs     Histogram `json:"think_time_ms"`
	Arrival         Timeline  `json:"arrival_timeline"`
}

const (
	histBins     = 24 // bars in a token/turn/think-time histogram
	timelineBins = 40 // slices in the arrival timeline
)

// StatsFromCSV computes the distributions of a stored trace's data.csv. Columns are found by
// name, so a trace lacking one simply reports an empty distribution for it. Timing columns are
// microseconds (per the TraceV2 header's time_unit) and are reported in milliseconds.
func StatsFromCSV(data []byte) (Stats, error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1 // trace CSVs are wide and may vary; do not enforce a column count
	head, err := r.Read()
	if err == io.EOF {
		return Stats{}, nil
	}
	if err != nil {
		return Stats{}, fmt.Errorf("parse CSV header: %w", err)
	}
	colOf := func(name string) int {
		for i, n := range head {
			if n == name {
				return i
			}
		}
		return -1
	}
	inputCol := colOf("input_tokens")
	outputCol := colOf("output_tokens")
	sessionCol := colOf("session_id")
	thinkCol := colOf("think_time_us")
	arrivalCol := colOf("arrival_time_us")

	var input, output, think, arrival []float64
	turns := map[string]int{}
	records := 0
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Stats{}, fmt.Errorf("parse CSV row %d: %w", records+1, err)
		}
		records++
		if v, ok := cell(row, inputCol); ok {
			input = append(input, v)
		}
		if v, ok := cell(row, outputCol); ok {
			output = append(output, v)
		}
		// Think time is empty for a session's first turn (no prior turn to wait after), so an
		// unparseable/empty cell is skipped rather than counted as zero; an explicit "0" is a
		// real back-to-back turn and is kept.
		if v, ok := cell(row, thinkCol); ok {
			think = append(think, v/1000) // us -> ms
		}
		if v, ok := cell(row, arrivalCol); ok {
			arrival = append(arrival, v/1000) // us -> ms
		}
		if sessionCol >= 0 && sessionCol < len(row) && row[sessionCol] != "" {
			turns[row[sessionCol]]++
		}
	}

	turnCounts := make([]float64, 0, len(turns))
	for _, c := range turns {
		turnCounts = append(turnCounts, float64(c))
	}

	return Stats{
		Records:         records,
		Sessions:        len(turns),
		InputTokens:     histogram(input, histBins),
		OutputTokens:    histogram(output, histBins),
		TurnsPerSession: histogram(turnCounts, histBins),
		ThinkTimeMs:     histogram(think, histBins),
		Arrival:         timeline(arrival, timelineBins),
	}, nil
}

// cell parses the float at column col of row, reporting ok=false when the column is absent,
// out of range, empty, or not a number — so a missing or blank field is skipped, not zeroed.
func cell(row []string, col int) (float64, bool) {
	if col < 0 || col >= len(row) || row[col] == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(row[col], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// histogram bins values into at most maxBins equal-width bars with summary stats. Integer data
// with a range no wider than maxBins gets unit-width integer bins for a clean axis (turns per
// session, small token counts); otherwise the range is split into maxBins equal bars.
func histogram(values []float64, maxBins int) Histogram {
	h := Histogram{Bins: []Bin{}, Count: len(values)}
	if len(values) == 0 {
		return h
	}
	sorted := slices.Clone(values)
	sort.Float64s(sorted)
	h.Min = sorted[0]
	h.Max = sorted[len(sorted)-1]
	h.Mean = mean(sorted)
	h.P50 = percentile(sorted, 50)
	h.P95 = percentile(sorted, 95)

	lo, hi := h.Min, h.Max
	if lo == hi {
		h.Bins = []Bin{{Lo: lo, Hi: hi, Count: len(sorted)}}
		return h
	}

	nbins := maxBins
	width := (hi - lo) / float64(nbins)
	if allIntegers(sorted) && (hi-lo) <= float64(maxBins) {
		lo = math.Floor(lo)
		width = 1
		nbins = int(math.Floor(hi)-lo) + 1
	}
	bins := make([]Bin, nbins)
	for i := range bins {
		bins[i].Lo = lo + float64(i)*width
		bins[i].Hi = lo + float64(i+1)*width
	}
	for _, v := range sorted {
		idx := int((v - lo) / width)
		if idx >= nbins {
			idx = nbins - 1 // the maximum falls in the last bin
		}
		if idx < 0 {
			idx = 0
		}
		bins[idx].Count++
	}
	h.Bins = bins
	return h
}

// timeline bins arrival times (ms) into nbuckets equal slices measured from the first arrival.
func timeline(arrivalsMs []float64, nbuckets int) Timeline {
	t := Timeline{Buckets: []TimeBucket{}, Count: len(arrivalsMs)}
	if len(arrivalsMs) == 0 {
		return t
	}
	sorted := slices.Clone(arrivalsMs)
	sort.Float64s(sorted)
	start, end := sorted[0], sorted[len(sorted)-1]
	t.SpanMs = end - start
	if t.SpanMs == 0 {
		t.Buckets = []TimeBucket{{TMs: 0, Count: len(sorted)}}
		return t
	}
	width := t.SpanMs / float64(nbuckets)
	buckets := make([]TimeBucket, nbuckets)
	for i := range buckets {
		buckets[i].TMs = float64(i) * width
	}
	for _, a := range sorted {
		idx := int((a - start) / width)
		if idx >= nbuckets {
			idx = nbuckets - 1
		}
		if idx < 0 {
			idx = 0
		}
		buckets[idx].Count++
	}
	t.Buckets = buckets
	return t
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

// percentile is the nearest-rank value of a pre-sorted slice (p in [0,100]).
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	rank = max(rank, 0)
	rank = min(rank, len(sorted)-1)
	return sorted[rank]
}

func allIntegers(xs []float64) bool {
	for _, x := range xs {
		if x != math.Trunc(x) {
			return false
		}
	}
	return true
}
