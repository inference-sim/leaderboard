package blisrun

import (
	"strconv"
	"strings"
)

// kvThrashingLabel is the label BLIS's printKVCacheMetrics writes before the thrashing
// rate (upstream cmd/root.go). internal/drift asserts it still appears in upstream
// source, so a rename there fails a test rather than silently blanking the column.
const kvThrashingLabel = "KV Thrashing Rate:"

// parseKVThrashing returns the KV thrashing rate BLIS printed to stdout, or nil when the
// KV Cache Metrics section is absent (BLIS omits the whole section when preemption rate,
// cache hit rate, and thrashing rate are all zero) or the value cannot be parsed. A
// reported 0 is a real value and returns a pointer to 0, distinct from the nil absence.
func parseKVThrashing(stdout string) *float64 {
	for _, line := range strings.Split(stdout, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), kvThrashingLabel)
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(rest), 64)
		if err != nil {
			return nil // malformed value: report "not reported" rather than a spurious zero
		}
		return &v
	}
	return nil
}
