package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/inference-sim/leaderboard/internal/modelcatalog"
)

// modelBody is the wire shape of a model submission (create/validate/update): a directory
// name and the two file bodies verbatim. The canonical name is derived from model.yaml, not
// sent, so it cannot drift from what is stored.
type modelBody struct {
	Dir        string `json:"dir"`
	ModelYAML  string `json:"model_yaml"`
	ConfigJSON string `json:"config_json"`
}

func (b modelBody) submission() modelcatalog.Submission {
	return modelcatalog.Submission{Dir: b.Dir, ModelYAML: b.ModelYAML, ConfigJSON: b.ConfigJSON}
}

// modelValidateResponse is what POST /api/models/validate returns: whether the model is
// acceptable, the derived canonical name / MoE flag / provider, and every reason it is not.
// It mirrors the workload validate response so the form handles the two the same way.
type modelValidateResponse struct {
	OK            bool     `json:"ok"`
	CanonicalName string   `json:"canonical_name"`
	MoE           bool     `json:"moe"`
	Provider      string   `json:"provider"`
	Issues        []string `json:"issues"`
}

func decodeModelBody(r *http.Request) (modelBody, error) {
	var b modelBody
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return modelBody{}, fmt.Errorf("could not read the model submission: %v", err)
	}
	return b, nil
}

// checkModelSubmission runs every check without writing: structural validation (our rules),
// a name-collision check against the catalog (the "new names only" rule), and the blis smoke
// test. excludeName is the canonical name of the model being replaced on an edit, so editing
// in place is not reported as colliding with itself. It returns the derived facts and the
// issues; OK is true only when there are none.
func (s *server) checkModelSubmission(b modelBody, excludeName string) modelValidateResponse {
	resp := modelValidateResponse{Issues: []string{}}
	v, err := b.submission().Validate()
	if err != nil {
		resp.Issues = append(resp.Issues, err.Error())
		return resp
	}
	resp.CanonicalName, resp.MoE, resp.Provider = v.Name, v.MoE, v.Provider

	// Collision is by directory, not canonical name: the directory is the model's on-disk
	// identity (<catalog>/models/<dir>), so a different org under the same directory would
	// still clobber an existing model's files. excludeName is the model being edited, whose
	// own directory is not a collision with itself.
	if b.Dir != modelDirOf(excludeName) {
		models, err := modelcatalog.List(s.catalogRoot, s.userModelsDir)
		if err != nil {
			resp.Issues = append(resp.Issues, err.Error())
			return resp
		}
		for _, m := range models {
			if modelDirOf(m.Name) == b.Dir {
				resp.Issues = append(resp.Issues, fmt.Sprintf("a model already occupies the directory "+
					"%q (%s); choose another directory name", b.Dir, m.Name))
				return resp
			}
		}
	}

	if s.validateModel != nil {
		if err := s.validateModel(b.submission(), v.Name); err != nil {
			resp.Issues = append(resp.Issues, err.Error())
			return resp
		}
	}
	resp.OK = len(resp.Issues) == 0
	return resp
}

// handleModelValidate is the dry run: it never writes. It reports the derived canonical
// name, MoE flag and provider, and every reason the model is not acceptable (our rules, a
// collision, or blis's own errors).
func (s *server) handleModelValidate(w http.ResponseWriter, r *http.Request) {
	b, err := decodeModelBody(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	// ?name= is the model being edited, so validating an edit in place does not report the
	// model colliding with itself. Absent when validating a new model.
	writeJSON(w, http.StatusOK, s.checkModelSubmission(b, r.URL.Query().Get("name")))
}

// handleModelCreate validates a submission and, if it passes, writes it to the pristine
// store and the live catalog. A name that already exists is a 409; a submission blis or our
// rules reject is a 422.
func (s *server) handleModelCreate(w http.ResponseWriter, r *http.Request) {
	b, err := decodeModelBody(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.modelMu.Lock()
	defer s.modelMu.Unlock()

	resp := s.checkModelSubmission(b, "")
	if !resp.OK {
		httpError(w, modelRejectionStatus(resp), strings.Join(resp.Issues, "; "))
		return
	}
	if err := s.modelStore().Save(b.submission()); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleModelUpdate replaces a user model's files. The model is named by ?name= (its
// canonical name). A base model is read-only (403); an unknown name is 404. A rename is not
// supported: the directory is the model's identity, so the body's dir must match.
func (s *server) handleModelUpdate(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	b, err := decodeModelBody(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.modelMu.Lock()
	defer s.modelMu.Unlock()

	dir, status, msg := s.resolveUserModel(name)
	if status != 0 {
		httpError(w, status, msg)
		return
	}
	if b.Dir != dir {
		httpError(w, http.StatusBadRequest, fmt.Sprintf("the directory %q does not match the model "+
			"being edited (%q); to rename, delete it and add a new one", b.Dir, dir))
		return
	}
	resp := s.checkModelSubmission(b, name)
	if !resp.OK {
		httpError(w, modelRejectionStatus(resp), strings.Join(resp.Issues, "; "))
		return
	}
	if err := s.modelStore().Save(b.submission()); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleModelDelete removes a user model (named by ?name=) from both stores. A base model is
// read-only (403); an unknown name is 404.
func (s *server) handleModelDelete(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	s.modelMu.Lock()
	defer s.modelMu.Unlock()

	dir, status, msg := s.resolveUserModel(name)
	if status != 0 {
		httpError(w, status, msg)
		return
	}
	if err := s.modelStore().Delete(dir); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": name})
}

// resolveUserModel maps a canonical name to the user model's directory, or an HTTP error: a
// name not in the catalog is 404, a base (image-shipped) model is 403 (read-only, the model
// analogue of a built-in workload). A zero status means dir is the directory to act on.
func (s *server) resolveUserModel(name string) (dir string, status int, msg string) {
	if name == "" {
		return "", http.StatusBadRequest, "the name query parameter is required"
	}
	models, err := modelcatalog.List(s.catalogRoot, s.userModelsDir)
	if err != nil {
		return "", http.StatusInternalServerError, err.Error()
	}
	for _, m := range models {
		if m.Name != name {
			continue
		}
		if m.Origin != "user" {
			return "", http.StatusForbidden, fmt.Sprintf("%q is a base catalog model and is "+
				"read-only; it cannot be edited or deleted from here", name)
		}
		// The directory is the model-half of the canonical name.
		return modelDirOf(name), 0, ""
	}
	return "", http.StatusNotFound, fmt.Sprintf("no model named %q in the catalog", name)
}

func (s *server) modelStore() modelcatalog.Store {
	return modelcatalog.Store{CatalogRoot: s.catalogRoot, UserModelsDir: s.userModelsDir}
}

// modelDirOf is the directory half of a canonical "<org>/<dir>" model name — the model's
// on-disk identity. An empty name (no model being edited) is "".
func modelDirOf(name string) string {
	if name == "" {
		return ""
	}
	return name[strings.LastIndex(name, "/")+1:]
}

// modelRejectionStatus maps a failed validation to its HTTP status: a directory collision is
// a 409 (the resource exists), everything else a 422 (the submission is unprocessable).
func modelRejectionStatus(resp modelValidateResponse) int {
	for _, issue := range resp.Issues {
		if strings.Contains(issue, "already occupies") {
			return http.StatusConflict
		}
	}
	return http.StatusUnprocessableEntity
}

// handleModels serves the models the Declare-a-run form offers, read live from the
// blis-catalog clone (BLIS_CATALOG) — the same clone blis resolves configs against — so
// the form's list is never a hand-maintained snapshot. Each entry is an org-prefixed name,
// a MoE flag, and the architecture spec the Catalog's model cards show. An unreadable
// catalog (BLIS_CATALOG unset, or the clone missing) is a
// server misconfiguration surfaced as a 500 the form shows, exactly as an unreachable
// workload catalog is; per design there is no committed fallback list.
func (s *server) handleModels(w http.ResponseWriter, r *http.Request) {
	models, err := modelcatalog.List(s.catalogRoot, s.userModelsDir)
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
	detail, err := modelcatalog.Config(s.catalogRoot, s.userModelsDir, name)
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
