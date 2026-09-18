package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/inference-sim/leaderboard/internal/drift"
	"github.com/inference-sim/leaderboard/internal/schema"
)

func cmdValidate(args []string) error {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	var c commonFlags
	c.bind(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}

	var problems int
	report := func(format string, a ...any) {
		problems++
		fmt.Fprintf(os.Stderr, "  "+format+"\n", a...)
	}

	fmt.Printf("runs.yaml (%s)\n", c.runsPath)
	plan, err := loadPlan(c)
	if err != nil {
		report("%v", err)
	} else {
		gid, err := schema.GroupID(plan.Group)
		if err != nil {
			report("%v", err)
		} else {
			fmt.Printf("  ok — group %s, %d candidates\n", gid, len(plan.Runs))
		}
	}

	fmt.Printf("stored results (%s)\n", c.outDir)
	paths, err := filepath.Glob(filepath.Join(c.outDir, "*", "*.json"))
	if err != nil {
		return fmt.Errorf("glob %s: %w", c.outDir, err)
	}
	var checked int
	for _, p := range paths {
		if filepath.Ext(p) != ".json" || isSidecar(p) {
			continue
		}
		body, err := os.ReadFile(p)
		if err != nil {
			report("%s: %v", p, err)
			continue
		}
		if err := schema.Validate(body); err != nil {
			report("%s: %v", p, err)
			continue
		}

		var rec schema.Record
		if err := json.Unmarshal(body, &rec); err != nil {
			report("%s: %v", p, err)
			continue
		}
		// The path is part of the contract: results/<group_id>/<run_id>.json. A
		// record filed under the wrong group would join the wrong table.
		wantDir := filepath.Base(filepath.Dir(p))
		if wantDir != rec.GroupID {
			report("%s: filed under %q but its group_id is %q", p, wantDir, rec.GroupID)
		}
		if base := filepath.Base(p); base != rec.RunID+".json" {
			report("%s: filename does not match run_id %q", p, rec.RunID)
		}
		gid, err := schema.GroupID(rec.Group)
		if err != nil {
			report("%s: %v", p, err)
			continue
		}
		if gid != rec.GroupID {
			report("%s: group_id %q recomputes to %q", p, rec.GroupID, gid)
		}
		wid, err := schema.WorkID(rec.Group)
		if err != nil {
			report("%s: %v", p, err)
			continue
		}
		if wid != rec.WorkID {
			report("%s: work_id %q recomputes to %q", p, rec.WorkID, wid)
		}
		checked++
	}
	fmt.Printf("  ok — %d records validated\n", checked)

	fmt.Printf("upstream drift (%s)\n", drift.DefaultMetricsPath)
	metricsPath := filepath.Join(c.blisDir, "sim", "metrics_utils.go")
	upstream, err := drift.RequiredJSONFields(metricsPath, "MetricsOutput")
	if err != nil {
		report("%v", err)
	} else {
		contract, err := schema.RequiredCoreNames()
		if err != nil {
			report("%v", err)
		} else if err := drift.Compare(upstream, contract); err != nil {
			report("%v", err)
		} else {
			fmt.Printf("  ok — %d required core fields match upstream\n", len(upstream))
		}
	}

	if problems > 0 {
		return fmt.Errorf("%d problem(s)", problems)
	}
	return nil
}

// isSidecar reports whether p is a per-request sidecar rather than a record.
func isSidecar(p string) bool {
	base := filepath.Base(p)
	const suffix = ".requests.json"
	return len(base) > len(suffix) && base[len(base)-len(suffix):] == suffix
}
