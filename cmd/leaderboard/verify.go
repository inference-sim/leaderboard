package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"

	"github.com/inference-sim/leaderboard/internal/blisrun"
	"github.com/inference-sim/leaderboard/internal/schema"
)

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	var c commonFlags
	c.bind(fs)
	only := fs.String("run", "", "verify only this run_id")
	if err := fs.Parse(args); err != nil {
		return err
	}

	plan, err := loadPlan(c)
	if err != nil {
		return err
	}
	runner, err := blisrun.NewRunner(c.blisDir)
	if err != nil {
		return err
	}
	groupID, err := schema.GroupID(plan.Group)
	if err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp("", "leaderboard-verify-")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	var differed, missing int
	for _, cand := range plan.Runs {
		if *only != "" && cand.RunID != *only {
			continue
		}
		storedPath := filepath.Join(c.outDir, groupID, cand.RunID+".json")
		body, err := os.ReadFile(storedPath)
		if err != nil {
			missing++
			fmt.Fprintf(os.Stderr, "MISSING %s: %v\n", cand.RunID, err)
			continue
		}
		var stored schema.Record
		if err := json.Unmarshal(body, &stored); err != nil {
			missing++
			fmt.Fprintf(os.Stderr, "MISSING %s: %v\n", cand.RunID, err)
			continue
		}

		fresh, err := runner.Run(plan.Group, blisrun.RunSpec{
			RunID: cand.RunID, Deployment: cand.Deployment,
		}, filepath.Join(tmpDir, cand.RunID+".json"))
		if err != nil {
			differed++
			fmt.Fprintf(os.Stderr, "FAIL %s: %v\n", cand.RunID, err)
			continue
		}

		var notes []string
		if a, b := dropMetricsPath(stored.Provenance.Argv), dropMetricsPath(fresh.Provenance.Argv); !reflect.DeepEqual(a, b) {
			notes = append(notes, fmt.Sprintf("argv changed:\n  stored: %v\n   fresh: %v", a, b))
		}
		notes = append(notes, diffMetrics(stored.Metrics, fresh.Metrics)...)

		if len(notes) == 0 {
			fmt.Printf("ok   %-22s reproduced\n", cand.RunID)
			continue
		}
		differed++
		fmt.Fprintf(os.Stderr, "DIFF %s (stored at %s, blis %s%s)\n",
			cand.RunID, stored.Provenance.RanAt, stored.Provenance.BlisCommit,
			dirtyNote(stored.Provenance.BlisTreeDirty))
		for _, n := range notes {
			fmt.Fprintf(os.Stderr, "  %s\n", n)
		}
	}

	if differed > 0 || missing > 0 {
		return fmt.Errorf("%d run(s) differed, %d missing — BLIS is deterministic, so a "+
			"difference with no flag change is a bug worth chasing, not noise", differed, missing)
	}
	return nil
}

// dropMetricsPath removes the trailing "--metrics-path <path>" pair from an argv
// before comparing two runs. blisrun.Argv always appends it last (see argv.go), and
// its value is a fresh temp path this command creates on every invocation — it
// names where blis should write output, not an input that could make two runs
// differ. Comparing it verbatim would report "argv changed" on every verify,
// masking any real flag change underneath it.
func dropMetricsPath(argv []string) []string {
	for i, a := range argv {
		if a == "--metrics-path" && i+1 < len(argv) {
			out := make([]string, 0, len(argv)-2)
			out = append(out, argv[:i]...)
			out = append(out, argv[i+2:]...)
			return out
		}
	}
	return argv
}

func dirtyNote(dirty bool) string {
	if dirty {
		return ", tree dirty"
	}
	return ""
}

// diffMetrics reports every metric field that changed, by json name. It takes only
// metrics: provenance differs between any two runs (ran_at, wall_s), and including
// it would make verify cry wolf on every invocation.
func diffMetrics(a, b schema.Metrics) []string {
	am, err := asFieldMap(a)
	if err != nil {
		return []string{fmt.Sprintf("compare stored metrics: %v", err)}
	}
	bm, err := asFieldMap(b)
	if err != nil {
		return []string{fmt.Sprintf("compare fresh metrics: %v", err)}
	}

	names := make([]string, 0, len(am))
	for k := range am {
		names = append(names, k)
	}
	sort.Strings(names)

	var out []string
	for _, name := range names {
		if !reflect.DeepEqual(am[name], bm[name]) {
			out = append(out, fmt.Sprintf("%s: stored %v, fresh %v", name, am[name], bm[name]))
		}
	}
	return out
}

func asFieldMap(m schema.Metrics) (map[string]any, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}
