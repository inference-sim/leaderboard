package blisrun

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/schema"
	"github.com/inference-sim/leaderboard/internal/status"
)

// stderrTailBytes is how much of a failed run's stderr is reported. Enough to
// carry a logrus.Fatalf line, short enough to read.
const stderrTailBytes = 2000

// RunSpec is one candidate to execute.
type RunSpec struct {
	RunID      string
	Deployment schema.Deployment
	// WorkloadName is the catalog name the run was declared with (a preset or saved
	// profile), stored on the record for display. Empty for a runs.yaml run, which has
	// no named workload.
	WorkloadName string
}

// Runner executes blis from the upstream checkout and assembles records.
type Runner struct {
	// Binary is the blis executable, relative to Cwd.
	Binary string
	// Cwd is the upstream checkout. blis resolves its config files relative to it.
	Cwd string
	// KeepRequests writes the per-request array to a sidecar. Off by default: the
	// MVP table needs none of it and it is 36x the aggregate payload.
	KeepRequests bool

	commit       string
	dirty        bool
	binarySHA256 string
}

// NewRunner checks the upstream checkout and captures provenance once, so every
// record from one invocation agrees about what produced it.
func NewRunner(cwd string) (*Runner, error) {
	binary := "./blis"
	abs := filepath.Join(cwd, "blis")
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("blisrun: %s not found — run `make blis` first: %w", abs, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("blisrun: %s is a directory", abs)
	}

	body, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("blisrun: read %s: %w", abs, err)
	}
	sum := sha256.Sum256(body)

	commit, dirty, err := GitProvenance(cwd)
	if err != nil {
		return nil, err
	}
	return &Runner{
		Binary:       binary,
		Cwd:          cwd,
		commit:       commit,
		dirty:        dirty,
		binarySHA256: hex.EncodeToString(sum[:])[:16],
	}, nil
}

// GitProvenance reports the upstream commit and whether its tree is dirty. Never
// assume the upstream working tree is clean or on main — check, record, and let the
// UI show the caveat.
func GitProvenance(cwd string) (string, bool, error) {
	head, err := exec.Command("git", "-C", cwd, "rev-parse", "--short=8", "HEAD").Output()
	if err != nil {
		return "", false, fmt.Errorf("blisrun: git rev-parse in %s: %w", cwd, err)
	}
	porcelain, err := exec.Command("git", "-C", cwd, "status", "--porcelain").Output()
	if err != nil {
		return "", false, fmt.Errorf("blisrun: git status in %s: %w", cwd, err)
	}
	return strings.TrimSpace(string(head)), len(bytes.TrimSpace(porcelain)) > 0, nil
}

// Run executes one candidate and returns its record. On any failure it returns an
// error and no partial record: a half-written result is worse than a missing one.
func (r *Runner) Run(g schema.Group, c RunSpec, metricsPath string) (schema.Record, error) {
	// A workload-spec run needs its inline spec on disk for --workload-spec. It is
	// written next to the metrics file (a per-run temp dir the caller owns), so it is
	// cleaned up with everything else. blis resolves the path relative to its own cwd,
	// so an absolute path is used.
	specPath := ""
	if g.Workload.Type == "workload-spec" {
		var err error
		specPath, err = writeSpecFile(g.Workload.Spec, metricsPath)
		if err != nil {
			return schema.Record{}, fmt.Errorf("blisrun: %s: %w", c.RunID, err)
		}
		// spec_sha256 is the content hash of the inline spec and is folded into group_id, so
		// it must reflect the spec actually run. A record built from a saved profile arrives
		// with it set, but one built inline by the web app (the custom card) carries the spec
		// without a hash, so it is computed here from the spec itself — the single source of
		// truth — rather than trusted from the request. g is a value, so this stays local to
		// the record this run writes.
		sha, err := schema.SpecSHA256(g.Workload.Spec)
		if err != nil {
			return schema.Record{}, fmt.Errorf("blisrun: %s: spec_sha256: %w", c.RunID, err)
		}
		g.Workload.SpecSHA256 = &sha
	}
	argv := Argv(r.Binary, g, c.Deployment, metricsPath, specPath)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = r.Cwd
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = nil // stdout is a lesser copy of the metrics file; ignore it

	started := time.Now()
	runErr := cmd.Run()
	wall := time.Since(started).Seconds()

	if runErr != nil {
		return schema.Record{}, fmt.Errorf("blisrun: %s: blis exited with %w\nstderr tail:\n%s",
			c.RunID, runErr, tail(stderr.String()))
	}

	raw, err := os.ReadFile(metricsPath)
	if err != nil {
		return schema.Record{}, fmt.Errorf(
			"blisrun: %s: blis exited 0 but %s is unreadable: %w\nstderr tail:\n%s",
			c.RunID, metricsPath, err, tail(stderr.String()))
	}
	core, rawMap, requests, err := SplitMetrics(raw)
	if err != nil {
		return schema.Record{}, fmt.Errorf("blisrun: %s: %w", c.RunID, err)
	}

	groupID, err := schema.GroupID(g)
	if err != nil {
		return schema.Record{}, fmt.Errorf("blisrun: %s: %w", c.RunID, err)
	}
	workID, err := schema.WorkID(g)
	if err != nil {
		return schema.Record{}, fmt.Errorf("blisrun: %s: %w", c.RunID, err)
	}

	var sidecar *string
	if r.KeepRequests && requests != nil {
		p := filepath.Join("results", groupID, c.RunID+".requests.json")
		sidecar = &p
	}

	rec := schema.Record{
		SchemaVersion: schema.SchemaVersion,
		RunID:         c.RunID,
		GroupID:       groupID,
		WorkID:        workID,
		WorkloadName:  c.WorkloadName,
		Group:         g,
		Deployment:    c.Deployment,
		Provenance: schema.Provenance{
			BlisCommit:    r.commit,
			BlisTreeDirty: r.dirty,
			BinarySHA256:  r.binarySHA256,
			Argv:          argv,
			Cwd:           r.Cwd,
			RanAt:         started.UTC().Format(time.RFC3339),
			WallS:         wall,
		},
		Status:          status.Evaluate(core, g),
		Metrics:         core,
		MetricsRaw:      rawMap,
		RequestsSidecar: sidecar,
	}
	if err := schema.ValidateRecord(rec); err != nil {
		return schema.Record{}, fmt.Errorf("blisrun: %s: %w", c.RunID, err)
	}
	return rec, nil
}

// specValidateTimeout bounds the wall-clock time a spec smoke run may take: enough for
// blis to parse the spec and inject a single request, not enough to hang a form.
const specValidateTimeout = 60 * time.Second

// ValidateSpec runs blis on an inline WorkloadSpec purely to surface blis's own parse
// and semantic errors. blis has no validate subcommand, so this smoke run is the
// mechanism (design §5): a probe model/hardware (the spec is model-free, blis requires
// both) and --num-requests 1 so it terminates after one request. It returns nil when
// blis accepts the spec, or blis's stderr tail otherwise.
func (r *Runner) ValidateSpec(spec map[string]any, probeModel, probeHardware string) error {
	tmpDir, err := os.MkdirTemp("", "leaderboard-validate-")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	specPath, err := writeSpecFile(spec, filepath.Join(tmpDir, "spec.json"))
	if err != nil {
		return err
	}
	argv := []string{r.Binary, "run",
		"--model", probeModel, "--hardware", probeHardware, "--tp", "1",
		"--workload-spec", specPath,
		"--num-requests", "1",
		"--metrics-path", filepath.Join(tmpDir, "m.json"),
	}

	ctx, cancel := context.WithTimeout(context.Background(), specValidateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = r.Cwd
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("blis did not finish validating the spec within %s", specValidateTimeout)
		}
		return fmt.Errorf("blis rejected the workload spec:\n%s", tail(strings.TrimSpace(stderr.String())))
	}
	return nil
}

// writeSpecFile materializes an inline WorkloadSpec to a YAML file beside metricsPath
// and returns its absolute path, so --workload-spec (resolved relative to blis's cwd)
// finds it. blis strict-parses the spec, so a well-formed map is required.
func writeSpecFile(spec map[string]any, metricsPath string) (string, error) {
	body, err := yaml.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("encode workload spec: %w", err)
	}
	path := strings.TrimSuffix(metricsPath, filepath.Ext(metricsPath)) + ".spec.yaml"
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve spec path: %w", err)
	}
	if err := os.WriteFile(abs, body, 0o644); err != nil {
		return "", fmt.Errorf("write workload spec %s: %w", abs, err)
	}
	return abs, nil
}

// RequestsPayload returns the per-request array for the sidecar, or nil.
func (r *Runner) RequestsPayload(metricsPath string) (json.RawMessage, error) {
	raw, err := os.ReadFile(metricsPath)
	if err != nil {
		return nil, fmt.Errorf("blisrun: read %s: %w", metricsPath, err)
	}
	_, _, requests, err := SplitMetrics(raw)
	return requests, err
}

// SplitMetrics divides one blis metrics file three ways (D5: a named set validated
// strictly, the rest preserved as-is): the required core (the 27 fields BLIS always
// emits, strictly decoded), everything blis emitted minus requests[] (verbatim, so
// an omitempty field this build does not know about is not lost), and requests[]
// itself for the sidecar.
func SplitMetrics(raw []byte) (schema.Metrics, map[string]any, json.RawMessage, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return schema.Metrics{}, nil, nil, fmt.Errorf("parse metrics file: %w", err)
	}

	// Every core field must be present. A missing one means either a truncated file
	// or an upstream change, and both should stop the run rather than write a
	// record with a silent zero.
	names, err := schema.RequiredCoreNames()
	if err != nil {
		return schema.Metrics{}, nil, nil, err
	}
	var missing []string
	for _, n := range names {
		if _, ok := probe[n]; !ok {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		return schema.Metrics{}, nil, nil, fmt.Errorf(
			"metrics file is missing required core field(s): %s — either the file is "+
				"truncated or upstream's MetricsOutput changed (run `make drift`)",
			strings.Join(missing, ", "))
	}

	var core schema.Metrics
	if err := json.Unmarshal(raw, &core); err != nil {
		return schema.Metrics{}, nil, nil, fmt.Errorf("decode core metrics: %w", err)
	}

	requests := probe["requests"]
	delete(probe, "requests")

	rawMap := make(map[string]any, len(probe))
	for k, v := range probe {
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			return schema.Metrics{}, nil, nil, fmt.Errorf("decode metrics_raw field %q: %w", k, err)
		}
		rawMap[k] = val
	}
	return core, rawMap, requests, nil
}

func tail(s string) string {
	if len(s) <= stderrTailBytes {
		return s
	}
	return "…" + s[len(s)-stderrTailBytes:]
}
