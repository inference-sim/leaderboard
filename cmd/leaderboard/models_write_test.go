package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/modelcatalog"
)

// newModelServer returns a server pointed at a fresh, writable temp catalog containing one
// base model, plus an empty user-models store. validateModel is stubbed to accept, so these
// tests exercise the HTTP/storage layer without blis.
func newModelServer(t *testing.T) *server {
	t.Helper()
	catalog := t.TempDir()
	userStore := t.TempDir()
	base := filepath.Join(catalog, "models", "llama-base")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "model.yaml"),
		[]byte("source:\n  provider: huggingface\n  repo: Meta/Llama-Base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "config.json"),
		[]byte(`{"architectures":["LlamaForCausalLM"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return &server{
		catalogRoot:   catalog,
		userModelsDir: userStore,
		validateModel: func(modelcatalog.Submission, string) error { return nil },
	}
}

func modelReq(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

const createBody = `{"dir":"my-model","model_yaml":"source:\n  provider: huggingface\n  repo: Acme/My-Model\n","config_json":"{\"architectures\":[\"AcmeForCausalLM\"]}"}`

func TestHandleModelCreateWritesAndListsAsUser(t *testing.T) {
	s := newModelServer(t)

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models", createBody))
	if rr.Code != http.StatusOK {
		t.Fatalf("POST /api/models: got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}

	// Written to both the live catalog and the pristine store.
	if _, err := os.Stat(filepath.Join(s.catalogRoot, "models", "my-model", "config.json")); err != nil {
		t.Errorf("model not written to live catalog: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.userModelsDir, "my-model", "config.json")); err != nil {
		t.Errorf("model not written to pristine store: %v", err)
	}

	// Listed with origin "user".
	lr := httptest.NewRecorder()
	s.routes().ServeHTTP(lr, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	var got struct {
		Models []struct {
			Name   string `json:"name"`
			Origin string `json:"origin"`
		} `json:"models"`
	}
	if err := json.Unmarshal(lr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	var origin string
	for _, m := range got.Models {
		if m.Name == "acme/my-model" {
			origin = m.Origin
		}
	}
	if origin != "user" {
		t.Errorf("acme/my-model origin = %q, want user", origin)
	}
}

func TestHandleModelCreateCollisionWithBaseIs409(t *testing.T) {
	s := newModelServer(t)
	body := `{"dir":"llama-base","model_yaml":"source:\n  repo: Meta/Llama-Base\n","config_json":"{}"}`
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models", body))
	if rr.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409 (%s)", rr.Code, rr.Body.String())
	}
}

// A different org but the same directory name still collides: the directory is the model's
// on-disk identity, so writing it would clobber the base model's files even though the
// canonical names differ.
func TestHandleModelCreateDirCollisionAcrossOrgsIs409(t *testing.T) {
	s := newModelServer(t)
	// Base model is meta/llama-base (dir llama-base). Submit the same dir under acme.
	body := `{"dir":"llama-base","model_yaml":"source:\n  repo: Acme/Llama-Base\n","config_json":"{}"}`
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models", body))
	if rr.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409 for a directory collision across orgs (%s)", rr.Code, rr.Body.String())
	}
}

func TestHandleModelCreateInvalidStructureIs422(t *testing.T) {
	s := newModelServer(t)
	body := `{"dir":"bad","model_yaml":"source:\n  repo: Acme/Bad\n","config_json":"{not json"}`
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models", body))
	if rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d, want 422 (%s)", rr.Code, rr.Body.String())
	}
}

func TestHandleModelCreateSmokeTestFailureIs422(t *testing.T) {
	s := newModelServer(t)
	s.validateModel = func(modelcatalog.Submission, string) error { return fmt.Errorf("blis rejected the model") }
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models", createBody))
	if rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d, want 422 (%s)", rr.Code, rr.Body.String())
	}
	// Nothing written when the smoke test fails.
	if _, err := os.Stat(filepath.Join(s.catalogRoot, "models", "my-model")); !os.IsNotExist(err) {
		t.Errorf("model written despite smoke-test failure (err=%v)", err)
	}
}

func TestHandleModelValidateDryRunDoesNotWrite(t *testing.T) {
	s := newModelServer(t)
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPost, "/api/models/validate", createBody))
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	var got struct {
		OK            bool   `json:"ok"`
		CanonicalName string `json:"canonical_name"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.CanonicalName != "acme/my-model" {
		t.Errorf("validate = %+v, want ok true, name acme/my-model", got)
	}
	if _, err := os.Stat(filepath.Join(s.catalogRoot, "models", "my-model")); !os.IsNotExist(err) {
		t.Errorf("validate wrote the model (err=%v); it must be a dry run", err)
	}
}

func TestHandleModelDeleteUserModel(t *testing.T) {
	s := newModelServer(t)
	s.routes().ServeHTTP(httptest.NewRecorder(), modelReq(http.MethodPost, "/api/models", createBody))

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/api/models?name=acme/my-model", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.userModelsDir, "my-model")); !os.IsNotExist(err) {
		t.Errorf("user model still in store after delete (err=%v)", err)
	}
}

func TestHandleModelDeleteBaseIs403(t *testing.T) {
	s := newModelServer(t)
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/api/models?name=meta/llama-base", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403 (%s)", rr.Code, rr.Body.String())
	}
	// Still present.
	if _, err := os.Stat(filepath.Join(s.catalogRoot, "models", "llama-base")); err != nil {
		t.Errorf("base model deleted: %v", err)
	}
}

func TestHandleModelUpdateUserModel(t *testing.T) {
	s := newModelServer(t)
	s.routes().ServeHTTP(httptest.NewRecorder(), modelReq(http.MethodPost, "/api/models", createBody))

	edited := `{"dir":"my-model","model_yaml":"source:\n  provider: huggingface\n  repo: Acme/My-Model\n","config_json":"{\"architectures\":[\"AcmeForCausalLM\"],\"hidden_size\":2048}"}`
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPut, "/api/models?name=acme/my-model", edited))
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	cfg, _ := os.ReadFile(filepath.Join(s.userModelsDir, "my-model", "config.json"))
	if !strings.Contains(string(cfg), "2048") {
		t.Errorf("edit not persisted; config = %q", cfg)
	}
}

func TestHandleModelUpdateBaseIs403(t *testing.T) {
	s := newModelServer(t)
	body := `{"dir":"llama-base","model_yaml":"source:\n  repo: Meta/Llama-Base\n","config_json":"{}"}`
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, modelReq(http.MethodPut, "/api/models?name=meta/llama-base", body))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403 (%s)", rr.Code, rr.Body.String())
	}
}
