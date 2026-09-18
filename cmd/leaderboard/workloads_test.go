package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/catalog"
)

func catalogServer(t *testing.T) *server {
	t.Helper()
	s := &server{catalogPath: filepath.Join(t.TempDir(), "workloads.yaml")}
	// Default: every spec is accepted, so handler tests do not need a blis binary.
	s.validateSpec = func(map[string]any) error { return nil }
	return s
}

func distBody(name string, rate float64) profileBody {
	return profileBody{
		Name: name, Seed: 42,
		Workload: workloadBody{
			Type: "distribution", NumRequests: 500,
			Load:         &loadBody{Kind: "rate", Value: rate},
			PromptTokens: 512, PromptTokensStdev: 256,
			OutputTokens: 128, OutputTokensStdev: 256,
		},
	}
}

func do(t *testing.T, s *server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		raw, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, bytes.NewReader(raw))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rr := httptest.NewRecorder()
	s.workloadsMux().ServeHTTP(rr, r)
	return rr
}

func listBodies(t *testing.T, s *server) []profileBody {
	t.Helper()
	rr := do(t, s, http.MethodGet, "/api/workloads", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body)
	}
	var resp struct {
		Workloads []profileBody `json:"workloads"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp.Workloads
}

// An empty file is not an empty catalog: the four presets are always present (§11, B1),
// each flagged builtin so the browser can badge it read-only.
func TestWorkloadsGetReturnsPresetsWhenFileEmpty(t *testing.T) {
	s := catalogServer(t)
	got := listBodies(t, s)
	if len(got) != 4 {
		t.Fatalf("want the 4 presets, got %d", len(got))
	}
	for _, b := range got {
		if !b.Builtin {
			t.Errorf("preset %q should be flagged builtin", b.Name)
		}
	}
}

func TestWorkloadsGetListsUserProfileAfterPresets(t *testing.T) {
	s := catalogServer(t)
	if rr := do(t, s, http.MethodPost, "/api/workloads", distBody("mine", 6)); rr.Code != http.StatusOK {
		t.Fatalf("create status %d: %s", rr.Code, rr.Body)
	}
	got := listBodies(t, s)
	if len(got) != 5 {
		t.Fatalf("want 4 presets + 1 user profile, got %d", len(got))
	}
	last := got[4]
	if last.Name != "mine" || last.Builtin {
		t.Errorf("user profile should follow the presets and not be builtin: %+v", last)
	}
}

func TestWorkloadsCreateRejectsNamingAPreset(t *testing.T) {
	s := catalogServer(t)
	rr := do(t, s, http.MethodPost, "/api/workloads", distBody("chatbot", 6))
	if rr.Code != http.StatusConflict {
		t.Fatalf("want 409 naming a preset, got %d: %s", rr.Code, rr.Body)
	}
}

func TestWorkloadsCreateRejectsTwinningAPreset(t *testing.T) {
	s := catalogServer(t)
	// A profile with the chatbot preset's exact spec content, under a new name.
	twin := presetBody(t, "chatbot")
	twin.Name = "my-chat"
	rr := do(t, s, http.MethodPost, "/api/workloads", twin)
	if rr.Code != http.StatusConflict {
		t.Fatalf("want 409 twinning a preset, got %d: %s", rr.Code, rr.Body)
	}
	if !strings.Contains(rr.Body.String(), "chatbot") {
		t.Errorf("twin rejection should point at the preset: %s", rr.Body)
	}
}

func TestWorkloadsUpdatePresetRefused(t *testing.T) {
	s := catalogServer(t)
	edit := presetBody(t, "chatbot")
	rr := do(t, s, http.MethodPut, "/api/workloads/chatbot", edit)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("want 403 editing a preset, got %d: %s", rr.Code, rr.Body)
	}
}

func TestWorkloadsDeletePresetRefused(t *testing.T) {
	s := catalogServer(t)
	rr := do(t, s, http.MethodDelete, "/api/workloads/chatbot", nil)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("want 403 deleting a preset, got %d: %s", rr.Code, rr.Body)
	}
}

// presetBody returns the wire body of the named preset, so a test can propose a twin or
// an edit of it through the same shape the browser sends.
func presetBody(t *testing.T, name string) profileBody {
	t.Helper()
	for _, p := range catalog.Presets() {
		if p.Name == name {
			return profileToBody(p)
		}
	}
	t.Fatalf("no preset named %q", name)
	return profileBody{}
}

func TestWorkloadsCreateThenGet(t *testing.T) {
	s := catalogServer(t)
	if rr := do(t, s, http.MethodPost, "/api/workloads", distBody("chat-6rps", 6)); rr.Code != http.StatusOK {
		t.Fatalf("create status %d: %s", rr.Code, rr.Body)
	}
	// It is persisted and readable.
	c, err := catalog.Read(s.catalogPath)
	if err != nil || len(c.Profiles) != 1 || c.Profiles[0].Name != "chat-6rps" {
		t.Fatalf("catalog not persisted: %+v (%v)", c, err)
	}
	rr := do(t, s, http.MethodGet, "/api/workloads", nil)
	if !strings.Contains(rr.Body.String(), "chat-6rps") {
		t.Fatalf("GET missing the new profile: %s", rr.Body)
	}
}

func TestWorkloadsCreateRejectsDuplicateName(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("chat", 6))
	rr := do(t, s, http.MethodPost, "/api/workloads", distBody("chat", 10))
	if rr.Code != http.StatusConflict {
		t.Fatalf("want 409 on duplicate name, got %d: %s", rr.Code, rr.Body)
	}
}

func TestWorkloadsCreateRejectsTwinContent(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("chat-a", 6))
	rr := do(t, s, http.MethodPost, "/api/workloads", distBody("chat-b", 6))
	if rr.Code != http.StatusConflict {
		t.Fatalf("want 409 on twin content, got %d: %s", rr.Code, rr.Body)
	}
	if !strings.Contains(rr.Body.String(), "chat-a") {
		t.Errorf("twin rejection should point at the existing profile: %s", rr.Body)
	}
}

func TestWorkloadsValidateDoesNotWrite(t *testing.T) {
	s := catalogServer(t)
	rr := do(t, s, http.MethodPost, "/api/workloads/validate", distBody("chat-6rps", 6))
	if rr.Code != http.StatusOK {
		t.Fatalf("validate status %d: %s", rr.Code, rr.Body)
	}
	var resp validateResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.OK || resp.Variant != "distribution" {
		t.Errorf("want ok distribution, got %+v", resp)
	}
	if !strings.Contains(resp.Summary, "500 requests") {
		t.Errorf("summary should describe the work: %q", resp.Summary)
	}
	// Nothing was written.
	c, _ := catalog.Read(s.catalogPath)
	if len(c.Profiles) != 0 {
		t.Errorf("validate must not write the catalog")
	}
}

func TestWorkloadsValidateReportsTwin(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("chat-6rps", 6))
	rr := do(t, s, http.MethodPost, "/api/workloads/validate", distBody("proposed", 6))
	var resp validateResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp.Twin == nil || *resp.Twin != "chat-6rps" {
		t.Errorf("want twin chat-6rps, got %+v", resp.Twin)
	}
}

func TestWorkloadsValidateRunsSpecValidator(t *testing.T) {
	s := catalogServer(t)
	called := false
	s.validateSpec = func(map[string]any) error { called = true; return nil }
	spec := profileBody{Name: "cohort", Seed: 1, Workload: workloadBody{
		Type: "workload-spec", Spec: map[string]any{"version": "2", "aggregate_rate": 20},
	}}
	do(t, s, http.MethodPost, "/api/workloads/validate", spec)
	if !called {
		t.Error("a workload-spec profile must be handed to the spec validator")
	}
}

func TestWorkloadsValidateSurfacesSpecError(t *testing.T) {
	s := catalogServer(t)
	s.validateSpec = func(map[string]any) error {
		return errString("parsing workload spec: unknown field \"bogus\"")
	}
	spec := profileBody{Name: "cohort", Seed: 1, Workload: workloadBody{
		Type: "workload-spec", Spec: map[string]any{"version": "2", "bogus": 1},
	}}
	rr := do(t, s, http.MethodPost, "/api/workloads/validate", spec)
	var resp validateResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp.OK {
		t.Error("a spec blis rejects must not validate")
	}
	if len(resp.Issues) == 0 || !strings.Contains(strings.Join(resp.Issues, " "), "bogus") {
		t.Errorf("blis's own error should be surfaced: %+v", resp.Issues)
	}
}

func TestWorkloadsValidateRejectsPinnedModel(t *testing.T) {
	s := catalogServer(t)
	blisRan := false
	s.validateSpec = func(map[string]any) error { blisRan = true; return nil }
	spec := profileBody{Name: "pinned", Seed: 1, Workload: workloadBody{
		Type: "workload-spec",
		Spec: map[string]any{"version": "2", "clients": []any{map[string]any{"model": "meta/llama"}}},
	}}
	rr := do(t, s, http.MethodPost, "/api/workloads/validate", spec)
	var resp validateResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp.OK {
		t.Error("a model-pinned spec must be rejected (P6)")
	}
	if blisRan {
		t.Error("a spec rejected on our own rules must not reach blis")
	}
}

func TestWorkloadsRename(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("old-name", 6))
	renamed := distBody("new-name", 6)
	rr := do(t, s, http.MethodPut, "/api/workloads/old-name", renamed)
	if rr.Code != http.StatusOK {
		t.Fatalf("rename status %d: %s", rr.Code, rr.Body)
	}
	c, _ := catalog.Read(s.catalogPath)
	if len(c.Profiles) != 1 || c.Profiles[0].Name != "new-name" {
		t.Fatalf("rename did not take: %+v", c.Profiles)
	}
}

func TestWorkloadsEditInPlaceIsNotItsOwnTwin(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("chat", 6))
	// Edit the rate, keep the name: must succeed (not a twin of itself).
	rr := do(t, s, http.MethodPut, "/api/workloads/chat", distBody("chat", 12))
	if rr.Code != http.StatusOK {
		t.Fatalf("edit-in-place status %d: %s", rr.Code, rr.Body)
	}
}

func TestWorkloadsDelete(t *testing.T) {
	s := catalogServer(t)
	do(t, s, http.MethodPost, "/api/workloads", distBody("chat", 6))
	rr := do(t, s, http.MethodDelete, "/api/workloads/chat", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete status %d: %s", rr.Code, rr.Body)
	}
	c, _ := catalog.Read(s.catalogPath)
	if len(c.Profiles) != 0 {
		t.Fatalf("delete did not take: %+v", c.Profiles)
	}
}

func TestWorkloadsDeleteMissingIs404(t *testing.T) {
	s := catalogServer(t)
	rr := do(t, s, http.MethodDelete, "/api/workloads/ghost", nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("want 404 deleting a missing profile, got %d", rr.Code)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
