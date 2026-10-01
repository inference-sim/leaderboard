package modelcatalog

import (
	"os"
	"path/filepath"
	"testing"
)

const goodMoEConfig = `{"architectures":["AcmeMoeForCausalLM"],"num_experts":64,"hidden_size":1024}`

func goodSubmission() Submission {
	return Submission{
		Dir:        "my-model",
		ModelYAML:  "source:\n  provider: huggingface\n  repo: Acme/My-Model\n  revision: r1\n",
		ConfigJSON: goodMoEConfig,
	}
}

func TestValidateDerivesNameMoEProvider(t *testing.T) {
	v, err := goodSubmission().Validate()
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if v.Name != "acme/my-model" {
		t.Errorf("name = %q, want acme/my-model", v.Name)
	}
	if !v.MoE {
		t.Errorf("MoE = false, want true (config declares num_experts)")
	}
	if v.Provider != "huggingface" {
		t.Errorf("provider = %q, want huggingface", v.Provider)
	}
}

func TestValidateRejectsBadDir(t *testing.T) {
	for _, dir := range []string{"", "..", "My-Model", "a/b", ".hidden", "has space"} {
		s := goodSubmission()
		s.Dir = dir
		if _, err := s.Validate(); err == nil {
			t.Errorf("Validate(dir=%q) = nil error, want rejection", dir)
		}
	}
}

func TestValidateRejectsModelYAMLWithoutOrgPrefix(t *testing.T) {
	s := goodSubmission()
	s.ModelYAML = "source:\n  provider: huggingface\n  repo: justaname\n" // no "<org>/"
	if _, err := s.Validate(); err == nil {
		t.Error("Validate with no org-prefixed repo = nil error, want rejection")
	}
}

func TestValidateRejectsUnparseableConfigJSON(t *testing.T) {
	s := goodSubmission()
	s.ConfigJSON = "{not json"
	if _, err := s.Validate(); err == nil {
		t.Error("Validate with unparseable config.json = nil error, want rejection")
	}
}

func TestSaveWritesBothStoreAndLiveCatalog(t *testing.T) {
	catalog := t.TempDir()
	userStore := t.TempDir()
	st := Store{CatalogRoot: catalog, UserModelsDir: userStore}

	if err := st.Save(goodSubmission()); err != nil {
		t.Fatalf("Save: %v", err)
	}

	for _, base := range []string{
		filepath.Join(userStore, "my-model"),
		filepath.Join(catalog, "models", "my-model"),
	} {
		my, err := os.ReadFile(filepath.Join(base, "model.yaml"))
		if err != nil {
			t.Fatalf("read model.yaml under %s: %v", base, err)
		}
		if string(my) != goodSubmission().ModelYAML {
			t.Errorf("model.yaml under %s = %q, want the submitted bytes", base, my)
		}
		cfg, err := os.ReadFile(filepath.Join(base, "config.json"))
		if err != nil {
			t.Fatalf("read config.json under %s: %v", base, err)
		}
		if string(cfg) != goodMoEConfig {
			t.Errorf("config.json under %s = %q, want the submitted bytes", base, cfg)
		}
	}
}

func TestDeleteRemovesFromBoth(t *testing.T) {
	catalog := t.TempDir()
	userStore := t.TempDir()
	st := Store{CatalogRoot: catalog, UserModelsDir: userStore}
	if err := st.Save(goodSubmission()); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := st.Delete("my-model"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	for _, p := range []string{
		filepath.Join(userStore, "my-model"),
		filepath.Join(catalog, "models", "my-model"),
	} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still exists after Delete (err=%v)", p, err)
		}
	}
}
