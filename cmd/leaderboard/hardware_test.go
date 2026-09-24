package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// A server pointed at the hardware fixture serves its accelerators as JSON.
func TestHandleHardwareServesCatalog(t *testing.T) {
	// handleHardware reads hardware_config.json from blisDir; the hardware package's
	// testdata dir holds a trimmed copy.
	s := &server{blisDir: filepath.Join("..", "..", "internal", "hardware", "testdata")}

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/hardware", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/hardware: got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	var got struct {
		Hardware []struct {
			Name    string         `json:"name"`
			Aliases []string       `json:"aliases"`
			Spec    map[string]any `json:"spec"`
		} `json:"hardware"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(got.Hardware) != 4 {
		t.Fatalf("got %d entries, want 4: %+v", len(got.Hardware), got.Hardware)
	}
	// Sorted by name, with aliases and the numeric spec carried through.
	first := got.Hardware[0]
	if first.Name != "A100-80" {
		t.Errorf("first entry = %q, want A100-80", first.Name)
	}
	if len(first.Aliases) != 1 || first.Aliases[0] != "A100-SXM" {
		t.Errorf("A100-80 aliases = %v, want [A100-SXM]", first.Aliases)
	}
	if first.Spec["MemoryGiB"] != 80.0 {
		t.Errorf("A100-80 MemoryGiB = %v, want 80", first.Spec["MemoryGiB"])
	}
	// An accelerator with no aliases must serialize its aliases as [] not null: the browser
	// spreads this list, and a null would throw and blank the Catalog page.
	if strings.Contains(rr.Body.String(), `"aliases":null`) {
		t.Errorf("aliases must marshal as [] not null: %s", rr.Body.String())
	}
}

// An unreadable config (here: a blisDir with no hardware_config.json) is surfaced
// as a 500 the page can show.
func TestHandleHardwareUnreadableConfigIs500(t *testing.T) {
	s := &server{blisDir: t.TempDir()}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/hardware", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rr.Code)
	}
}
