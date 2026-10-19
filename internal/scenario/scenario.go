// Package scenario turns a leaderboard Deployment into a blis-schemas scenario file,
// the unit a deployment became in blis v0.10.0 (#1851): a two-document YAML (a Scenario
// naming the model, hardware and coefficient sets, and a Deployment giving one pool's
// parallelism and engine knobs). blis run reads it via --scenarios/--scenario instead of
// the old --model/--hardware flags.
//
// The split follows the v0.10.0 flag surface exactly: model, hardware, tp/dp/EP and the
// engine knobs (block size, batch/seq caps, model length, KV dtype, GPU memory, quant)
// live in the scenario; the scheduling/routing/admission knobs stay CLI flags (argv.go).
// Knobs blis v0.10.0 removed outright are refused here rather than silently dropped, so a
// deployment never simulates something other than what it declared.
package scenario

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// EngineVersion is the blis engine release the pinned catalog + registry are fitted
// against. A coefficient set is valid only for the version it was fitted to, so this is
// not cosmetic; it is pinned alongside the dependency triple in root .env.
const EngineVersion = "0.29.0"

// coefficientSets are the blis-registry sets every scenario names, in order. The pinned
// registry (root .env) carries exactly these; they are the cost model's standard basis.
var coefficientSets = []string{
	"cost-model-primitives",
	"cost-model-collectives",
	"cost-model-host-overheads",
	"cost-model-attention",
	"cost-model-recurrent",
	"cost-model-memory",
}

type scenarioDoc struct {
	Kind          string     `yaml:"kind"`
	Name          string     `yaml:"name"`
	Model         string     `yaml:"model"`
	Coefficients  []string   `yaml:"coefficients"`
	EngineVersion string     `yaml:"engine_version"`
	Cluster       clusterDoc `yaml:"cluster"`
}

type clusterDoc struct {
	Hardware    string `yaml:"hardware"`
	Nodes       int    `yaml:"nodes"`
	GPUsPerNode int    `yaml:"gpus_per_node"`
}

type deploymentDoc struct {
	Kind  string    `yaml:"kind"`
	Name  string    `yaml:"name"`
	Pools []poolDoc `yaml:"pools"`
}

type poolDoc struct {
	Role     string      `yaml:"role"`
	Nodes    int         `yaml:"nodes"`
	Parallel parallelDoc `yaml:"parallel"`
	Engine   engineDoc   `yaml:"engine"`
}

type parallelDoc struct {
	TP                   int  `yaml:"tp"`
	PP                   int  `yaml:"pp"`
	DP                   int  `yaml:"dp"`
	EnableExpertParallel bool `yaml:"enable_expert_parallel"`
}

type engineDoc struct {
	Quantization         string  `yaml:"quantization,omitempty"`
	CacheDType           string  `yaml:"cache_dtype,omitempty"`
	BlockSize            int     `yaml:"block_size,omitempty"`
	MaxNumBatchedTokens  int     `yaml:"max_num_batched_tokens,omitempty"`
	MaxNumSeqs           int     `yaml:"max_num_seqs,omitempty"`
	MaxModelLen          int     `yaml:"max_model_len,omitempty"`
	GPUMemoryUtilization float64 `yaml:"gpu_memory_utilization,omitempty"`
}

// CatalogModel maps the leaderboard's org-prefixed model name (qwen/qwen3-14b) to the
// blis-catalog models/ directory name (qwen3-14b), which is what a scenario's `model:`
// field references. The catalog keys models by the bare name under models/<name>/.
func CatalogModel(model string) string {
	if i := strings.LastIndex(model, "/"); i >= 0 {
		return model[i+1:]
	}
	return model
}

// Generate renders the two-document scenario YAML for one deployment and returns it with
// the scenario name (used as both the file stem and the Scenario.name). catalogRoot is
// the blis-catalog clone (BLIS_CATALOG); the model must exist under its models/ tree.
func Generate(d schema.Deployment, catalogRoot string) (body []byte, name string, err error) {
	// Knobs blis v0.10.0 removed. Refuse a non-default value rather than drop it: a run
	// must simulate what it declared (the repo's "a diff with no flag change is a bug" rule).
	switch {
	case d.Disaggregation != nil:
		return nil, "", fmt.Errorf("scenario: prefill/decode disaggregation is not yet ported to the blis v0.10.0 scenario model")
	case d.MoECommBackend != "":
		return nil, "", fmt.Errorf("scenario: moe_comm_backend %q has no blis v0.10.0 equivalent", d.MoECommBackend)
	case d.TotalKVBlocks > 0:
		return nil, "", fmt.Errorf("scenario: total_kv_blocks is not supported under blis v0.10.0 (KV capacity is derived from the scenario)")
	case d.NumSpeculativeTokens > 0:
		return nil, "", fmt.Errorf("scenario: speculative decoding (num_speculative_tokens>0) is not yet ported to blis v0.10.0")
	}

	model := CatalogModel(d.Model)
	if _, statErr := os.Stat(filepath.Join(catalogRoot, "models", model, "graph.yaml")); statErr != nil {
		return nil, "", fmt.Errorf("scenario: model %q (catalog dir %q) not found under %s/models: %w",
			d.Model, model, catalogRoot, statErr)
	}

	tp := max1(d.TP)
	dp := max1(d.DP)
	name = fmt.Sprintf("%s-%s-tp%d", model, d.Hardware, tp)

	sc := scenarioDoc{
		Kind:          "Scenario",
		Name:          name,
		Model:         model,
		Coefficients:  coefficientSets,
		EngineVersion: EngineVersion,
		Cluster: clusterDoc{
			Hardware: d.Hardware,
			Nodes:    1,
			// One colocated pool occupies tp*dp ranks on a single node; size the node to it
			// (num_instances scales the deployment, per the kernel's "one pool, scale with
			// --num-instances" rule).
			GPUsPerNode: tp * dp,
		},
	}

	eng := engineDoc{
		BlockSize:            int(d.BlockSizeInTokens),
		MaxNumBatchedTokens:  int(d.MaxNumBatchedTokens),
		MaxNumSeqs:           int(d.MaxNumSeqs),
		MaxModelLen:          int(d.MaxModelLen), // 0 omitted: the engine auto-derives from the model config
		GPUMemoryUtilization: d.GPUMemoryUtilization,
	}
	// kv_cache_dtype "auto"/"" lets the engine decide, which is omission in the scenario.
	if d.KVCacheDtype != "" && d.KVCacheDtype != "auto" {
		eng.CacheDType = d.KVCacheDtype
	}
	// Precision/quantization: empty means the checkpoint's own format governs (the common
	// case). A dedicated field is added in a later phase; until then it is left to the model.

	dep := deploymentDoc{
		Kind: "Deployment",
		Name: name,
		Pools: []poolDoc{{
			Role:  "colocated",
			Nodes: 1,
			Parallel: parallelDoc{
				TP:                   tp,
				PP:                   1,
				DP:                   dp,
				EnableExpertParallel: d.EnableExpertParallel,
			},
			Engine: eng,
		}},
	}

	scYAML, err := yaml.Marshal(sc)
	if err != nil {
		return nil, "", fmt.Errorf("scenario: marshal Scenario: %w", err)
	}
	depYAML, err := yaml.Marshal(dep)
	if err != nil {
		return nil, "", fmt.Errorf("scenario: marshal Deployment: %w", err)
	}

	var b strings.Builder
	b.Write(scYAML)
	b.WriteString("---\n")
	b.Write(depYAML)
	return []byte(b.String()), name, nil
}

func max1(n int) int {
	if n < 1 {
		return 1
	}
	return n
}
