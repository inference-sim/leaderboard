package main

import (
	"errors"
	"net/http"

	"github.com/inference-sim/leaderboard/internal/modelcatalog"
)

// handleModels serves the models the Declare-a-run form offers, read live from the
// blis-catalog clone (BLIS_CATALOG) — the same clone blis resolves configs against — so
// the form's list is never a hand-maintained snapshot. Each entry is an org-prefixed name,
// a MoE flag, and the architecture spec the Catalog's model cards show. An unreadable
// catalog (BLIS_CATALOG unset, or the clone missing) is a
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

// handleModelConfig serves one model's detail on demand — its provenance and the raw
// config.json blis reads — for the Catalog's model view, which fetches it only when a reader
// opens a model. The model is named by the ?name= query param (its canonical org/model
// name). An unknown name is a 404 (the client asked for a model that is not in the catalog);
// an unreadable catalog is a 500, the same misconfiguration handleModels reports.
func (s *server) handleModelConfig(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		httpError(w, http.StatusBadRequest, "the name query parameter is required")
		return
	}
	detail, err := modelcatalog.Config(s.catalogRoot, name)
	if err != nil {
		if errors.Is(err, modelcatalog.ErrNotFound) {
			httpError(w, http.StatusNotFound, err.Error())
			return
		}
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, detail)
}
