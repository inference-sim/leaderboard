package traceingest

import (
	"reflect"
	"testing"
)

func TestConvertArgvOtel(t *testing.T) {
	got := convertArgv("./blis", "otel", "/in/trace.json", "/tmp/out",
		ConvertOptions{ContextGrowth: "accumulate", MaxThinkTime: "15s", MinRounds: 2, IncludeErrors: true})
	want := []string{
		"./blis", "convert", "otel",
		"--input", "/in/trace.json",
		"--trace-output", "/tmp/out",
		"--context-growth", "accumulate",
		"--max-think-time", "15s",
		"--min-rounds", "2",
		"--include-errors",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("convert argv drifted\n got: %v\nwant: %v", got, want)
	}
}

// --include-errors is an otel-only flag; a weka convert never emits it even when the
// option is set.
func TestConvertArgvWekaOmitsIncludeErrors(t *testing.T) {
	got := convertArgv("./blis", "weka", "/in/w.jsonl", "/tmp/out",
		ConvertOptions{ContextGrowth: "independent", MinRounds: 1, IncludeErrors: true})
	want := []string{
		"./blis", "convert", "weka",
		"--input", "/in/w.jsonl",
		"--trace-output", "/tmp/out",
		"--context-growth", "independent",
		"--min-rounds", "1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("weka convert argv drifted\n got: %v\nwant: %v", got, want)
	}
}

// max-think-time is emitted only when set, so the caller can accept blis's own default.
func TestConvertArgvOmitsUnsetMaxThinkTime(t *testing.T) {
	got := convertArgv("./blis", "weka", "/in/w.jsonl", "/tmp/out",
		ConvertOptions{ContextGrowth: "accumulate", MinRounds: 1})
	for i, a := range got {
		if a == "--max-think-time" {
			t.Errorf("emitted --max-think-time with no value set: %v (at %d)", got, i)
		}
	}
}
