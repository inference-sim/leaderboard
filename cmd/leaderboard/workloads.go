package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/catalog"
	"github.com/inference-sim/leaderboard/internal/schema"
)

// The workload catalog endpoints (design §5). They read and write workloads.yaml, the
// one (local) file of named workload profiles, and validate a proposed profile —
// handing a raw WorkloadSpec to blis itself so the errors are blis's own, not a port.
//
// profileBody is the wire shape of one profile, shared by GET output and
// create/edit/validate input. It mirrors the clean catalog YAML shape: a distribution
// profile carries the flat fields, a spec profile carries `spec` (+ its hash on
// output). Kept separate from catalog.Profile so the HTTP contract is explicit.
type profileBody struct {
	Name            string       `json:"name"`
	Seed            int64        `json:"seed"`
	HorizonTicks    *int64       `json:"horizon_ticks"`
	RequestTimeoutS *int         `json:"request_timeout_s"`
	Workload        workloadBody `json:"workload"`
	// Builtin is output-only: true for a shipped preset, so the catalog browser badges it
	// and disables Edit/Rename/Delete (§11.2). It is ignored on input — a request cannot
	// declare itself a preset.
	Builtin bool `json:"builtin,omitempty"`
}

type workloadBody struct {
	Type              string    `json:"type"`
	NumRequests       int       `json:"num_requests,omitempty"`
	Load              *loadBody `json:"load,omitempty"`
	PromptTokens      int       `json:"prompt_tokens,omitempty"`
	PromptTokensStdev int       `json:"prompt_tokens_stdev,omitempty"`
	OutputTokens      int       `json:"output_tokens,omitempty"`
	OutputTokensStdev int       `json:"output_tokens_stdev,omitempty"`
	SpecSHA256        *string   `json:"spec_sha256,omitempty"`
	// Spec is the inline WorkloadSpec as an object; SpecYAML is the same authored as
	// YAML text. The editor sends SpecYAML (the browser has no YAML parser and the raw
	// mode is a text area); the server parses it here with the same parser blis uses.
	// GET returns both, so the editor can round-trip the text. SpecYAML wins if both
	// are present.
	Spec     map[string]any `json:"spec,omitempty"`
	SpecYAML *string        `json:"spec_yaml,omitempty"`
}

type loadBody struct {
	Kind  string  `json:"kind"`
	Value float64 `json:"value"`
}

// validateResponse is what /api/workloads/validate returns: whether the profile is
// runnable, the variant it would be stored as, the one-line work summary, the name of
// a content twin if any (P3), and every reason it is not yet runnable.
type validateResponse struct {
	OK      bool     `json:"ok"`
	Variant string   `json:"variant"`
	Summary string   `json:"summary"`
	Twin    *string  `json:"twin"`
	Issues  []string `json:"issues"`
}

// toProfile resolves a wire body into a catalog profile, applying the request-timeout
// default the same way the file loader does and parsing a raw spec_yaml if the client
// sent one instead of a spec object.
func (b profileBody) toProfile() (catalog.Profile, error) {
	timeout := 300
	if b.RequestTimeoutS != nil {
		timeout = *b.RequestTimeoutS
	}
	w := catalog.Workload{
		Type:              b.Workload.Type,
		NumRequests:       b.Workload.NumRequests,
		PromptTokens:      b.Workload.PromptTokens,
		PromptTokensStdev: b.Workload.PromptTokensStdev,
		OutputTokens:      b.Workload.OutputTokens,
		OutputTokensStdev: b.Workload.OutputTokensStdev,
		Spec:              b.Workload.Spec,
	}
	if b.Workload.SpecYAML != nil && strings.TrimSpace(*b.Workload.SpecYAML) != "" {
		var spec map[string]any
		if err := yaml.Unmarshal([]byte(*b.Workload.SpecYAML), &spec); err != nil {
			return catalog.Profile{}, fmt.Errorf("the spec is not valid YAML: %v", err)
		}
		w.Spec = spec
	}
	if b.Workload.Load != nil {
		w.Load = schema.Load{Kind: b.Workload.Load.Kind, Value: b.Workload.Load.Value}
	}
	return catalog.Profile{
		Name:            b.Name,
		Seed:            b.Seed,
		HorizonTicks:    b.HorizonTicks,
		RequestTimeoutS: timeout,
		Workload:        w,
	}, nil
}

// profileToBody is the reverse, for GET output. A spec profile carries its content
// hash so the client can show it without recomputing.
func profileToBody(p catalog.Profile) profileBody {
	timeout := p.RequestTimeoutS
	b := profileBody{
		Name:            p.Name,
		Seed:            p.Seed,
		HorizonTicks:    p.HorizonTicks,
		RequestTimeoutS: &timeout,
		Builtin:         p.Builtin,
		Workload:        workloadBody{Type: p.Workload.Type},
	}
	switch p.Workload.Type {
	case "distribution":
		b.Workload.NumRequests = p.Workload.NumRequests
		b.Workload.Load = &loadBody{Kind: p.Workload.Load.Kind, Value: p.Workload.Load.Value}
		b.Workload.PromptTokens = p.Workload.PromptTokens
		b.Workload.PromptTokensStdev = p.Workload.PromptTokensStdev
		b.Workload.OutputTokens = p.Workload.OutputTokens
		b.Workload.OutputTokensStdev = p.Workload.OutputTokensStdev
	case "workload-spec":
		if sha, err := schema.SpecSHA256(p.Workload.Spec); err == nil {
			b.Workload.SpecSHA256 = &sha
		}
		b.Workload.Spec = p.Workload.Spec
		if y, err := yaml.Marshal(p.Workload.Spec); err == nil {
			s := string(y)
			b.Workload.SpecYAML = &s
		}
	}
	return b
}

// registerWorkloadRoutes adds the catalog endpoints to a mux. Go's method-and-path
// patterns pick the literal /validate over the {name} wildcard, so the two never
// collide, and they coexist with the older method-less /api/run pattern.
func (s *server) registerWorkloadRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workloads", s.handleWorkloadsList)
	mux.HandleFunc("POST /api/workloads", s.handleWorkloadCreate)
	mux.HandleFunc("POST /api/workloads/validate", s.handleWorkloadValidate)
	mux.HandleFunc("PUT /api/workloads/{name}", s.handleWorkloadUpdate)
	mux.HandleFunc("DELETE /api/workloads/{name}", s.handleWorkloadDelete)
}

// workloadsMux is a standalone mux carrying only the catalog routes, for tests.
func (s *server) workloadsMux() *http.ServeMux {
	mux := http.NewServeMux()
	s.registerWorkloadRoutes(mux)
	return mux
}

func (s *server) handleWorkloadsList(w http.ResponseWriter, r *http.Request) {
	c, err := catalog.Load(s.catalogPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	bodies := make([]profileBody, 0, len(c.Profiles))
	for _, p := range c.Profiles {
		bodies = append(bodies, profileToBody(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": catalog.SchemaVersion, "workloads": bodies})
}

// handleWorkloadValidate is the dry run: it never writes. It reports the variant, the
// work summary, a content twin if any, and the reasons the profile is not runnable —
// including blis's own errors for a raw spec.
func (s *server) handleWorkloadValidate(w http.ResponseWriter, r *http.Request) {
	body, err := decodeProfile(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	p, err := body.toProfile()
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := catalog.Load(s.catalogPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.validateProfile(p, c))
}

func (s *server) handleWorkloadCreate(w http.ResponseWriter, r *http.Request) {
	body, err := decodeProfile(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.catMu.Lock()
	defer s.catMu.Unlock()

	c, err := catalog.Load(s.catalogPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	p, err := body.toProfile()
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, exists := c.ByName(p.Name); exists {
		httpError(w, http.StatusConflict, fmt.Sprintf("a workload named %q already exists; "+
			"edit it or choose another name", p.Name))
		return
	}
	if status, msg := s.rejectIfUnrunnableOrTwin(p, c); status != 0 {
		httpError(w, status, msg)
		return
	}
	c.Profiles = append(c.Profiles, p)
	if err := c.Write(s.catalogPath); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, profileToBody(p))
}

func (s *server) handleWorkloadUpdate(w http.ResponseWriter, r *http.Request) {
	target := r.PathValue("name")
	body, err := decodeProfile(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.catMu.Lock()
	defer s.catMu.Unlock()

	c, err := catalog.Load(s.catalogPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	idx := -1
	for i, p := range c.Profiles {
		if p.Name == target {
			idx = i
			break
		}
	}
	if idx < 0 {
		httpError(w, http.StatusNotFound, fmt.Sprintf("no workload named %q to edit", target))
		return
	}
	if c.Profiles[idx].Builtin {
		httpError(w, http.StatusForbidden, fmt.Sprintf("%q is a built-in preset and is read-only; "+
			"author a new workload from it instead", target))
		return
	}
	p, err := body.toProfile()
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A rename must not collide with a different existing profile.
	if p.Name != target {
		if _, exists := c.ByName(p.Name); exists {
			httpError(w, http.StatusConflict, fmt.Sprintf("a workload named %q already exists", p.Name))
			return
		}
	}
	// Twin detection excludes the profile being replaced: editing it in place, or
	// renaming it, is not a collision with its former self.
	others := &catalog.Catalog{}
	for i, existing := range c.Profiles {
		if i != idx {
			others.Profiles = append(others.Profiles, existing)
		}
	}
	if status, msg := s.rejectIfUnrunnableOrTwin(p, others); status != 0 {
		httpError(w, status, msg)
		return
	}
	c.Profiles[idx] = p
	if err := c.Write(s.catalogPath); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, profileToBody(p))
}

func (s *server) handleWorkloadDelete(w http.ResponseWriter, r *http.Request) {
	target := r.PathValue("name")
	s.catMu.Lock()
	defer s.catMu.Unlock()

	c, err := catalog.Load(s.catalogPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	kept := make([]catalog.Profile, 0, len(c.Profiles))
	found := false
	for _, p := range c.Profiles {
		if p.Name == target {
			if p.Builtin {
				httpError(w, http.StatusForbidden, fmt.Sprintf("%q is a built-in preset and cannot "+
					"be deleted", target))
				return
			}
			found = true
			continue
		}
		kept = append(kept, p)
	}
	if !found {
		httpError(w, http.StatusNotFound, fmt.Sprintf("no workload named %q to delete", target))
		return
	}
	c.Profiles = kept
	if err := c.Write(s.catalogPath); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": target})
}

// validateProfile runs every check without writing: our own well-formedness and P6
// model-pinning rules first (fast, and they must pass before blis is worth running),
// then — for a well-formed raw spec — blis itself. The twin is reported whether or not
// the profile is otherwise runnable, so the editor can warn early.
func (s *server) validateProfile(p catalog.Profile, c *catalog.Catalog) validateResponse {
	resp := validateResponse{Variant: p.Workload.Type, Summary: summarize(p), Issues: []string{}}
	if twin, ok := c.FindContentTwin(p); ok {
		t := twin
		resp.Twin = &t
	}
	if err := catalog.Validate(p); err != nil {
		resp.Issues = append(resp.Issues, err.Error())
		return resp
	}
	if p.Workload.Type == "workload-spec" && s.validateSpec != nil {
		if err := s.validateSpec(p.Workload.Spec); err != nil {
			resp.Issues = append(resp.Issues, err.Error())
			return resp
		}
	}
	resp.OK = len(resp.Issues) == 0
	return resp
}

// rejectIfUnrunnableOrTwin maps a create/update to an HTTP error: 422 when the profile
// is not runnable (our rules or blis), 409 when its content twins an existing profile
// (P3). A zero status means it may be written.
func (s *server) rejectIfUnrunnableOrTwin(p catalog.Profile, c *catalog.Catalog) (int, string) {
	v := s.validateProfile(p, c)
	if !v.OK {
		return http.StatusUnprocessableEntity, strings.Join(v.Issues, "; ")
	}
	if v.Twin != nil {
		return http.StatusConflict, fmt.Sprintf("this workload has identical content to %q; "+
			"a workload has one name (P3). Reuse it, or change a field", *v.Twin)
	}
	return 0, ""
}

func decodeProfile(r *http.Request) (profileBody, error) {
	var b profileBody
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return profileBody{}, fmt.Errorf("could not read the profile: %v", err)
	}
	return b, nil
}

// summarize is the one-line work summary the validate response carries. It mirrors the
// web's workloadTitle phrasing for the distribution case; a spec is described by its
// aggregate rate when it declares one.
func summarize(p catalog.Profile) string {
	w := p.Workload
	if w.Type == "workload-spec" {
		if rate, ok := numberField(w.Spec["aggregate_rate"]); ok && rate > 0 {
			return fmt.Sprintf("spec-backed workload at %s req/s aggregate", trimFloat(rate))
		}
		return "spec-backed workload"
	}
	load := trimFloat(w.Load.Value) + " req/s"
	if w.Load.Kind == "concurrency" {
		load = trimFloat(w.Load.Value) + " concurrent sessions"
	}
	return fmt.Sprintf("%d requests at %s", w.NumRequests, load)
}

func numberField(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func trimFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
