package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// A server pointed at the modelcatalog fixture serves its models as JSON.
func TestHandleModelsServesCatalog(t *testing.T) {
	root := filepath.Join("..", "..", "internal", "modelcatalog", "testdata", "catalog")
	s := &server{catalogRoot: root}

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/models", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/models: got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	var got struct {
		Models []struct {
			Name string `json:"name"`
			MoE  bool   `json:"moe"`
		} `json:"models"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(got.Models) != 5 {
		t.Fatalf("got %d models, want 5: %+v", len(got.Models), got.Models)
	}
	// First by sort order, and MoE read from config.json.
	if got.Models[0].Name != "meta-llama/llama-3.1-8b-instruct" || got.Models[0].MoE {
		t.Errorf("first model = %+v, want meta-llama/llama-3.1-8b-instruct dense", got.Models[0])
	}
	if got.Models[3].Name != "qwen/qwen3-30b-a3b" || !got.Models[3].MoE {
		t.Errorf("model[3] = %+v, want qwen/qwen3-30b-a3b MoE", got.Models[3])
	}
}

// An unreadable catalog (here: BLIS_CATALOG unset) is surfaced as a 500 the form can show.
func TestHandleModelsUnreadableCatalogIs500(t *testing.T) {
	s := &server{catalogRoot: ""}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rr.Code)
	}
}

// GET /api/models/config?name= serves one model's detail: provenance and the raw config.json.
func TestHandleModelConfigServesDetail(t *testing.T) {
	root := filepath.Join("..", "..", "internal", "modelcatalog", "testdata", "catalog")
	s := &server{catalogRoot: root}

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/models/config?name=qwen/qwen3-30b-a3b", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	var got struct {
		Name   string `json:"name"`
		MoE    bool   `json:"moe"`
		Source struct {
			Repo     string `json:"repo"`
			Provider string `json:"provider"`
		} `json:"source"`
		Config string `json:"config"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if got.Name != "qwen/qwen3-30b-a3b" || !got.MoE || got.Source.Repo != "Qwen/Qwen3-30B-A3B" {
		t.Errorf("detail = %+v, want qwen3-30b-a3b MoE from Qwen/Qwen3-30B-A3B", got)
	}
	if got.Source.Provider != "huggingface" {
		t.Errorf("source.provider = %q, want huggingface", got.Source.Provider)
	}
	if got.Config == "" {
		t.Error("config should carry the raw config.json")
	}
}

// A name that is not in the catalog is a 404, not a 500.
func TestHandleModelConfigUnknownNameIs404(t *testing.T) {
	root := filepath.Join("..", "..", "internal", "modelcatalog", "testdata", "catalog")
	s := &server{catalogRoot: root}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/models/config?name=acme/nope", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 (%s)", rr.Code, rr.Body.String())
	}
}

// A missing name query param is a 400.
func TestHandleModelConfigMissingNameIs400(t *testing.T) {
	s := &server{catalogRoot: "whatever"}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/models/config", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rr.Code)
	}
}
