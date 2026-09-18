package catalog

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// The four preset names the leaderboard ships (design §11).
var presetNames = []string{"chatbot", "contentgen", "summarization", "multidoc"}

func TestPresetsAreFourModelFreeAndValid(t *testing.T) {
	ps := Presets()
	if len(ps) != 4 {
		t.Fatalf("want 4 presets, got %d", len(ps))
	}
	seen := map[string]bool{}
	for _, p := range ps {
		seen[p.Name] = true
		if !p.Builtin {
			t.Errorf("preset %q is not marked Builtin", p.Name)
		}
		if p.Workload.Type != "workload-spec" {
			t.Errorf("preset %q is %q, want workload-spec (B3)", p.Name, p.Workload.Type)
		}
		if p.Seed != 42 || p.HorizonTicks != nil || p.RequestTimeoutS != 300 {
			t.Errorf("preset %q group knobs drifted: seed=%d horizon=%v timeout=%d",
				p.Name, p.Seed, p.HorizonTicks, p.RequestTimeoutS)
		}
		// Model-free (P6) and otherwise well-formed: Validate must accept every preset.
		if err := Validate(p); err != nil {
			t.Errorf("preset %q does not pass Validate: %v", p.Name, err)
		}
	}
	for _, name := range presetNames {
		if !seen[name] {
			t.Errorf("preset %q is missing", name)
		}
	}
}

func TestLoadMergesPresetsAheadOfFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	user := &Catalog{Profiles: []Profile{distProfile("mine", 6)}}
	if err := user.Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(c.Profiles) != 5 {
		t.Fatalf("want 4 presets + 1 user profile, got %d", len(c.Profiles))
	}
	// Presets come first, in Presets() order; the user profile follows.
	for i, name := range presetNames {
		if c.Profiles[i].Name != name {
			t.Errorf("profile[%d] = %q, want preset %q", i, c.Profiles[i].Name, name)
		}
	}
	if c.Profiles[4].Name != "mine" {
		t.Errorf("user profile should follow the presets, got %q", c.Profiles[4].Name)
	}
}

func TestLoadOnMissingFileIsJustThePresets(t *testing.T) {
	c, err := Load(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatalf("load of a missing catalog should not error: %v", err)
	}
	if len(c.Profiles) != 4 {
		t.Fatalf("a fresh checkout has just the 4 presets, got %d", len(c.Profiles))
	}
}

func TestLoadRejectsUserFileNamingAPreset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	clash := distProfile("chatbot", 6) // a user profile named after a preset
	if err := (&Catalog{Profiles: []Profile{clash}}).Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := Load(path)
	if err == nil || !strings.Contains(err.Error(), "chatbot") {
		t.Fatalf("want a name collision with the chatbot preset, got %v", err)
	}
}

func TestLoadRejectsUserFileTwinningAPreset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	// A user profile with a preset's exact content under a different name.
	twin := Presets()[0]
	twin.Name = "my-chat"
	twin.Builtin = false
	if err := (&Catalog{Profiles: []Profile{twin}}).Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("want a content-twin rejection against the chatbot preset")
	}
	if !strings.Contains(err.Error(), "chatbot") || !strings.Contains(err.Error(), "my-chat") {
		t.Errorf("twin rejection should name both the preset and the user profile, got %v", err)
	}
}

func TestWriteAfterLoadPersistsOnlyUserProfiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workloads.yaml")
	if err := (&Catalog{Profiles: []Profile{distProfile("mine", 6)}}).Write(path); err != nil {
		t.Fatalf("write: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// A round-trip through Load then Write must not leak a preset into the file.
	if err := loaded.Write(path); err != nil {
		t.Fatalf("re-write: %v", err)
	}
	back, err := Read(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(back.Profiles) != 1 || back.Profiles[0].Name != "mine" {
		t.Fatalf("the file should hold only the user profile, got %+v", back.Profiles)
	}
}

func TestPresetGroupFoldsStableSpecSHA256(t *testing.T) {
	ids := map[string]string{}
	for _, p := range Presets() {
		g := p.Group()
		if g.Workload.SpecSHA256 == nil {
			t.Fatalf("preset %q resolved without a spec_sha256", p.Name)
		}
		id, err := schema.GroupID(g)
		if err != nil {
			t.Fatalf("preset %q GroupID: %v", p.Name, err)
		}
		// Deterministic: resolving the same preset again folds the same hash.
		again, _ := schema.GroupID(p.Group())
		if id != again {
			t.Errorf("preset %q group_id is not stable: %q vs %q", p.Name, id, again)
		}
		if prev, ok := ids[id]; ok {
			t.Errorf("presets %q and %q collide on group_id %q", prev, p.Name, id)
		}
		ids[id] = p.Name
	}
}
