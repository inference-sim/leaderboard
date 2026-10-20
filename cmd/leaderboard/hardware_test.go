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
	// handleHardware reads <catalogRoot>/hardware; the hardware package's testdata dir
	// holds a copy of the catalog's hardware/ dir, so point catalogRoot at that testdata.
	s := &server{catalogRoot: filepath.Join("..", "..", "internal", "hardware", "testdata")}

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
	if len(got.Hardware) != 9 {
		t.Fatalf("got %d entries, want 9: %+v", len(got.Hardware), got.Hardware)
	}
	// Sorted by name, with aliases and the numeric spec carried through.
	first := got.Hardware[0]
	if first.Name != "a100-80" {
		t.Errorf("first entry = %q, want a100-80", first.Name)
	}
	if len(first.Aliases) != 1 || first.Aliases[0] != "a100-sxm" {
		t.Errorf("a100-80 aliases = %v, want [a100-sxm]", first.Aliases)
	}
	if first.Spec["MemoryGiB"] != 80.0 {
		t.Errorf("a100-80 MemoryGiB = %v, want 80", first.Spec["MemoryGiB"])
	}
	// An accelerator with no aliases must serialize its aliases as [] not null: the browser
	// spreads this list, and a null would throw and blank the Catalog page.
	if strings.Contains(rr.Body.String(), `"aliases":null`) {
		t.Errorf("aliases must marshal as [] not null: %s", rr.Body.String())
	}
}

// An unreadable catalog (here: a catalogRoot with no hardware/ dir) is surfaced
// as a 500 the page can show.
func TestHandleHardwareUnreadableConfigIs500(t *testing.T) {
	s := &server{catalogRoot: t.TempDir()}
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/hardware", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rr.Code)
	}
}
