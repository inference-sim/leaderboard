package blisrun

import (
	"strings"
	"testing"
)

// A cobra usage error puts the actionable line first ("Error: unknown flag: …") and then
// dumps the full flag list. tail() alone would show only the flag list; the summary must
// surface the Error line instead.
func TestBlisStderrSummaryPrefersCobraError(t *testing.T) {
	stderr := "Error: unknown flag: --timeout\n" +
		"Usage:\n  blis replay [flags]\n\nFlags:\n" +
		strings.Repeat("  --some-flag string   a description\n", 200)
	got := blisStderrSummary(stderr)
	if !strings.Contains(got, "unknown flag: --timeout") {
		t.Errorf("summary dropped the cobra error line: %q", got)
	}
	if strings.Contains(got, "--some-flag") {
		t.Errorf("summary should not include the usage flag dump: %q", got)
	}
}

// A logrus fatal (blis's own validation errors) has no usage dump, so the tail is right.
func TestBlisStderrSummaryFallsBackToTail(t *testing.T) {
	stderr := `time="..." level=fatal msg="trace header has session_context_growth=accumulate ..."`
	got := blisStderrSummary(stderr)
	if !strings.Contains(got, "session_context_growth=accumulate") {
		t.Errorf("summary dropped the fatal message: %q", got)
	}
}
