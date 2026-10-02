package blisrun

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ValidateModel runs blis once against a candidate model purely to prove blis can load and
// start it — the model analogue of ValidateSpec. blis has no validate subcommand, so this
// smoke run is the mechanism: it stages a throwaway catalog (the base catalog with the
// candidate overlaid at models/<dir>), points blis at it via BLIS_CATALOG, and runs a single
// synthetic request. The live catalog is never touched, so an invalid model cannot pollute
// it. It returns nil when blis accepts the model, or blis's stderr tail otherwise.
//
// Passing this proves only that blis started the model, not that its config is correct or
// its numbers are trustworthy; the UI carries that caveat.
func (r *Runner) ValidateModel(baseCatalogRoot, dir, canonicalName, modelYAML, configJSON, probeHardware string) error {
	if baseCatalogRoot == "" {
		return fmt.Errorf("no model catalog to validate against: BLIS_CATALOG is unset")
	}
	tmpDir, err := os.MkdirTemp("", "leaderboard-model-validate-")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	staging := filepath.Join(tmpDir, "catalog")
	if err := stageCatalog(staging, baseCatalogRoot, dir, modelYAML, configJSON); err != nil {
		return err
	}

	// A single synthetic request on the candidate: enough to exercise model loading, not
	// enough to hang a form. No --workload-spec — the default synthetic workload is what we
	// want here, since we are testing the model, not a workload.
	argv := []string{r.Binary, "run",
		"--model", canonicalName, "--hardware", probeHardware, "--tp", "1",
		"--num-requests", "1",
		"--metrics-path", filepath.Join(tmpDir, "m.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), specValidateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = r.Cwd
	// blis locates the catalog via BLIS_CATALOG; override it to the staging catalog for this
	// run only (every other variable inherited), so the candidate resolves without the live
	// catalog needing the model.
	cmd.Env = append(os.Environ(), "BLIS_CATALOG="+staging)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("blis did not finish validating the model within %s", specValidateTimeout)
		}
		s := stderr.String()
		// A GPU-capacity error means the model loaded and blis then found the probe's single
		// GPU too small. That is a sizing choice (hardware and parallelism are picked in
		// Declare-a-run), not a model defect, so the model passes validation.
		if modelLoadsButDoesNotFit(s) {
			return nil
		}
		return fmt.Errorf("blis rejected the model:\n%s", tail(strings.TrimSpace(s)))
	}
	return nil
}

// modelLoadsButDoesNotFit reports whether a blis failure is a GPU-capacity/sizing error rather
// than a model defect. blis computes a model's memory footprint only after it has loaded the
// model, so these signatures mean the model is valid and merely needs more or larger GPUs than
// the single-GPU probe — a Declare-a-run decision, not an onboarding failure.
func modelLoadsButDoesNotFit(stderr string) bool {
	for _, sig := range []string{
		"exceeds available GPU memory",
		"Minimum GPUs required per instance",
	} {
		if strings.Contains(stderr, sig) {
			return true
		}
	}
	return false
}

// stageCatalog populates dst with the base catalog copied verbatim and the candidate model
// overlaid at models/<dir>, so blis can resolve the candidate alongside the real models
// (devices/, hardware/ and the base models all present) without the candidate touching the
// live tree. dst must be an empty, writable directory.
func stageCatalog(dst, baseCatalogRoot, dir, modelYAML, configJSON string) error {
	if err := copyTree(dst, baseCatalogRoot); err != nil {
		return fmt.Errorf("stage catalog: %w", err)
	}
	modelDir := filepath.Join(dst, "models", dir)
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		return fmt.Errorf("stage catalog: create %s: %w", modelDir, err)
	}
	if err := os.WriteFile(filepath.Join(modelDir, "model.yaml"), []byte(modelYAML), 0o644); err != nil {
		return fmt.Errorf("stage catalog: %w", err)
	}
	if err := os.WriteFile(filepath.Join(modelDir, "config.json"), []byte(configJSON), 0o644); err != nil {
		return fmt.Errorf("stage catalog: %w", err)
	}
	return nil
}

// copyTree copies the file tree rooted at src into dst (created if absent), following the
// directory structure. It copies regular files and directories; the blis-catalog is plain
// JSON/YAML with no symlinks or special files, so those are not handled.
func copyTree(dst, src string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(target, path)
	})
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
