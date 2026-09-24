package main

import (
	"net/http"
	"path/filepath"

	"github.com/inference-sim/leaderboard/internal/hardware"
)

// handleHardware serves the accelerators the Catalog page shows, read live from the
// upstream hardware_config.json (the same file runOnce checks a run's hardware
// against) so the list is a fact about what blis would accept rather than a
// hand-maintained snapshot. Each entry is a name, its aliases (spec-identical
// names), and blis's numeric spec. An unreadable config (a missing or malformed
// file) is a server misconfiguration surfaced as a 500 the page shows, exactly as
// an unreadable model catalog is.
func (s *server) handleHardware(w http.ResponseWriter, r *http.Request) {
	cat, err := hardware.Load(filepath.Join(s.blisDir, "hardware_config.json"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hardware": cat.Entries()})
}
