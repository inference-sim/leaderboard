package blisrun

import (
	"os"
	"path/filepath"
	"testing"
)

// stageCatalog builds the temporary catalog the model smoke test points blis at: the base
// catalog copied verbatim, with the candidate overlaid at models/<dir>. The copy keeps the
// catalog's sibling subtrees (devices/, hardware/, …) so blis resolves a run the same way it
// would against the real catalog, and the candidate never touches the live tree.
func TestStageCatalogOverlaysCandidateOnBase(t *testing.T) {
	base := t.TempDir()
	// A base catalog with an existing model and a sibling subtree.
	mustWrite(t, filepath.Join(base, "models", "existing", "config.json"), `{"architectures":["X"]}`)
	mustWrite(t, filepath.Join(base, "devices", "a100.json"), `{"name":"a100"}`)

	staging := t.TempDir()
	if err := stageCatalog(staging, base, "newmodel",
		"source:\n  repo: Acme/New\n", `{"architectures":["Y"]}`); err != nil {
		t.Fatalf("stageCatalog: %v", err)
	}

	// The base entries are present in the staging copy.
	if _, err := os.Stat(filepath.Join(staging, "models", "existing", "config.json")); err != nil {
		t.Errorf("base model not copied into staging: %v", err)
	}
	if _, err := os.Stat(filepath.Join(staging, "devices", "a100.json")); err != nil {
		t.Errorf("sibling subtree not copied into staging: %v", err)
	}
	// The candidate is overlaid under models/<dir>.
	my, err := os.ReadFile(filepath.Join(staging, "models", "newmodel", "model.yaml"))
	if err != nil || string(my) != "source:\n  repo: Acme/New\n" {
		t.Errorf("candidate model.yaml = %q (err %v), want the submitted bytes", my, err)
	}
	cfg, err := os.ReadFile(filepath.Join(staging, "models", "newmodel", "config.json"))
	if err != nil || string(cfg) != `{"architectures":["Y"]}` {
		t.Errorf("candidate config.json = %q (err %v), want the submitted bytes", cfg, err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
