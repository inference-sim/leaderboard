package scenario

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// catalogWith builds a throwaway blis-catalog root carrying just models/<name>/graph.yaml,
// which is all Generate's existence check reads. The name is the catalog dir name (the bare
// model name), not the org-prefixed one.
func catalogWith(t *testing.T, catalogModel string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "models", catalogModel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "graph.yaml"), []byte("kind: Graph\n"), 0o644); err != nil {
		t.Fatalf("write graph.yaml: %v", err)
	}
	return root
}

// baseDeployment is a minimal valid dense candidate: a model that will exist in the test
// catalog, on h100, tp2/dp1, with the engine knobs at their usual form defaults.
func baseDeployment() schema.Deployment {
	return schema.Deployment{
		Model:                "qwen/qwen3-14b",
		Hardware:             "h100",
		TP:                   2,
		DP:                   1,
		NumInstances:         1,
		MaxModelLen:          40960,
		BlockSizeInTokens:    16,
		MaxNumSeqs:           256,
		MaxNumBatchedTokens:  8192,
		GPUMemoryUtilization: 0.9,
		KVCacheDtype:         "auto",
		LatencyModel:         "trained-physics",
		Scheduler:            "fcfs",
		ExtraFlags:           map[string]string{},
	}
}

// parseDocs splits the two-document body and unmarshals each into a generic map, so the
// tests assert on the rendered YAML a reader (and blis) sees rather than on the internal
// structs. docs[0] is the Scenario, docs[1] the Deployment.
func parseDocs(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var docs []map[string]any
	dec := yaml.NewDecoder(strings.NewReader(string(body)))
	for {
		var m map[string]any
		err := dec.Decode(&m)
		if err != nil {
			break
		}
		docs = append(docs, m)
	}
	if len(docs) != 2 {
		t.Fatalf("want two YAML documents (Scenario + Deployment), got %d:\n%s", len(docs), body)
	}
	return docs
}

func TestCatalogModel(t *testing.T) {
	cases := map[string]string{
		"qwen/qwen3-14b":      "qwen3-14b",
		"zai-org/glm-5.2-fp8": "glm-5.2-fp8",
		"qwen3-14b":           "qwen3-14b", // already bare, passes through
		"":                    "",
	}
	for in, want := range cases {
		if got := CatalogModel(in); got != want {
			t.Errorf("CatalogModel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGenerateHappyPath(t *testing.T) {
	d := baseDeployment()
	root := catalogWith(t, "qwen3-14b")

	body, name, err := Generate(d, root)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if want := "qwen3-14b-h100-tp2"; name != want {
		t.Errorf("name = %q, want %q", name, want)
	}
	if !strings.Contains(string(body), "\n---\n") {
		t.Errorf("body is not two documents separated by ---:\n%s", body)
	}

	docs := parseDocs(t, body)
	sc, dep := docs[0], docs[1]

	if sc["kind"] != "Scenario" || dep["kind"] != "Deployment" {
		t.Errorf("doc kinds = %q / %q, want Scenario / Deployment", sc["kind"], dep["kind"])
	}
	if sc["model"] != "qwen3-14b" {
		t.Errorf("scenario.model = %v, want qwen3-14b (org prefix stripped)", sc["model"])
	}
	if sc["engine_version"] != EngineVersion {
		t.Errorf("scenario.engine_version = %v, want %q", sc["engine_version"], EngineVersion)
	}
	// The coefficient sets are the registry's standard basis, in order.
	coeffs, _ := sc["coefficients"].([]any)
	if len(coeffs) != len(coefficientSets) {
		t.Fatalf("scenario.coefficients has %d entries, want %d", len(coeffs), len(coefficientSets))
	}
	for i, c := range coeffs {
		if c != coefficientSets[i] {
			t.Errorf("coefficients[%d] = %v, want %q", i, c, coefficientSets[i])
		}
	}
	cluster, _ := sc["cluster"].(map[string]any)
	if cluster["hardware"] != "h100" {
		t.Errorf("cluster.hardware = %v, want h100", cluster["hardware"])
	}
	// One colocated pool occupies tp*dp ranks on one node.
	if gpn := cluster["gpus_per_node"]; gpn != 2 {
		t.Errorf("cluster.gpus_per_node = %v, want 2 (tp*dp)", gpn)
	}

	pools, _ := dep["pools"].([]any)
	if len(pools) != 1 {
		t.Fatalf("deployment has %d pools, want 1", len(pools))
	}
	pool, _ := pools[0].(map[string]any)
	if pool["role"] != "colocated" {
		t.Errorf("pool.role = %v, want colocated", pool["role"])
	}
	parallel, _ := pool["parallel"].(map[string]any)
	if parallel["tp"] != 2 || parallel["pp"] != 1 || parallel["dp"] != 1 {
		t.Errorf("pool.parallel = %v, want tp=2 pp=1 dp=1", parallel)
	}
	engine, _ := pool["engine"].(map[string]any)
	if engine["block_size"] != 16 || engine["max_num_seqs"] != 256 || engine["max_num_batched_tokens"] != 8192 {
		t.Errorf("engine knobs not rendered as declared: %v", engine)
	}
}

func TestGenerateGPUsPerNodeIsTPTimesDP(t *testing.T) {
	d := baseDeployment()
	d.TP = 4
	d.DP = 2
	root := catalogWith(t, "qwen3-14b")

	body, _, err := Generate(d, root)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	cluster, _ := parseDocs(t, body)[0]["cluster"].(map[string]any)
	if gpn := cluster["gpus_per_node"]; gpn != 8 {
		t.Errorf("cluster.gpus_per_node = %v, want 8 (tp4*dp2)", gpn)
	}
}

func TestGenerateOmitsZeroEngineKnobs(t *testing.T) {
	d := baseDeployment()
	d.MaxModelLen = 0 // 0 means the engine auto-derives it: omitted from the scenario.
	root := catalogWith(t, "qwen3-14b")

	body, _, err := Generate(d, root)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	engine, _ := parseDocs(t, body)[1]["pools"].([]any)[0].(map[string]any)["engine"].(map[string]any)
	if _, present := engine["max_model_len"]; present {
		t.Errorf("max_model_len=0 should be omitted (omitempty), got engine %v", engine)
	}
}

func TestGenerateKVCacheDtype(t *testing.T) {
	root := catalogWith(t, "qwen3-14b")

	// "auto" and "" both mean "let the engine decide" -> omitted.
	for _, dtype := range []string{"auto", ""} {
		d := baseDeployment()
		d.KVCacheDtype = dtype
		body, _, err := Generate(d, root)
		if err != nil {
			t.Fatalf("Generate (dtype=%q): %v", dtype, err)
		}
		engine, _ := parseDocs(t, body)[1]["pools"].([]any)[0].(map[string]any)["engine"].(map[string]any)
		if _, present := engine["cache_dtype"]; present {
			t.Errorf("kv_cache_dtype %q should be omitted, got engine %v", dtype, engine)
		}
	}

	// A real dtype is carried through as cache_dtype.
	d := baseDeployment()
	d.KVCacheDtype = "fp8"
	body, _, err := Generate(d, root)
	if err != nil {
		t.Fatalf("Generate (dtype=fp8): %v", err)
	}
	engine, _ := parseDocs(t, body)[1]["pools"].([]any)[0].(map[string]any)["engine"].(map[string]any)
	if engine["cache_dtype"] != "fp8" {
		t.Errorf("engine.cache_dtype = %v, want fp8", engine["cache_dtype"])
	}
}

func TestGenerateRefusesRemovedKnobs(t *testing.T) {
	root := catalogWith(t, "qwen3-14b")
	cases := map[string]func(*schema.Deployment){
		"disaggregation":    func(d *schema.Deployment) { d.Disaggregation = &schema.Disaggregation{} },
		"moe_comm_backend":  func(d *schema.Deployment) { d.MoECommBackend = "deepep" },
		"total_kv_blocks":   func(d *schema.Deployment) { d.TotalKVBlocks = 1024 },
		"speculative":       func(d *schema.Deployment) { d.NumSpeculativeTokens = 4 },
		"latency_model_alt": func(d *schema.Deployment) { d.LatencyModel = "roofline" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			d := baseDeployment()
			mutate(&d)
			if _, _, err := Generate(d, root); err == nil {
				t.Errorf("Generate should refuse %s, got nil error", name)
			}
		})
	}
}

// The historical default latency_model is treated as "unset", so a pre-v0.10.0 record still
// generates rather than being refused.
func TestGenerateAllowsDefaultLatencyModel(t *testing.T) {
	root := catalogWith(t, "qwen3-14b")
	for _, lm := range []string{"", "trained-physics"} {
		d := baseDeployment()
		d.LatencyModel = lm
		if _, _, err := Generate(d, root); err != nil {
			t.Errorf("Generate with latency_model=%q should be allowed, got %v", lm, err)
		}
	}
}

func TestGenerateMissingModel(t *testing.T) {
	root := catalogWith(t, "qwen3-14b")
	d := baseDeployment()
	d.Model = "qwen/does-not-exist"
	if _, _, err := Generate(d, root); err == nil {
		t.Error("Generate should fail when models/<name>/graph.yaml is absent, got nil")
	}
}

func TestMax1(t *testing.T) {
	cases := map[int]int{-3: 1, 0: 1, 1: 1, 2: 2, 64: 64}
	for in, want := range cases {
		if got := max1(in); got != want {
			t.Errorf("max1(%d) = %d, want %d", in, got, want)
		}
	}
}
