package main

import (
	"net/http"

	"github.com/inference-sim/leaderboard/internal/modelcatalog"
)

// handleModels serves the models the Declare-a-run form offers, read live from the
// blis-catalog clone (BLIS_CATALOG) — the same clone blis resolves configs against — so
// the form's list is never a hand-maintained snapshot. Each entry is an org-prefixed name
// and a MoE flag. An unreadable catalog (BLIS_CATALOG unset, or the clone missing) is a
// server misconfiguration surfaced as a 500 the form shows, exactly as an unreachable
// workload catalog is; per design there is no committed fallback list.
func (s *server) handleModels(w http.ResponseWriter, r *http.Request) {
	models, err := modelcatalog.List(s.catalogRoot)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}
