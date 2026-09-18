package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/inference-sim/leaderboard/internal/blisrun"
	"github.com/inference-sim/leaderboard/internal/hardware"
	"github.com/inference-sim/leaderboard/internal/schema"
	"github.com/inference-sim/leaderboard/internal/spec"
)

type commonFlags struct {
	runsPath string
	outDir   string
	blisDir  string
}

func (c *commonFlags) bind(fs *flag.FlagSet) {
	fs.StringVar(&c.runsPath, "runs", "runs.yaml", "path to the run declaration")
	fs.StringVar(&c.outDir, "out", "results", "directory to write results into")
	fs.StringVar(&c.blisDir, "blis", blisrun.Cwd, "upstream inference-sim checkout")
}

func loadPlan(c commonFlags) (*spec.Plan, error) {
	plan, err := spec.Load(c.runsPath)
	if err != nil {
		return nil, err
	}
	cat, err := hardware.Load(filepath.Join(c.blisDir, "hardware_config.json"))
	if err != nil {
		return nil, err
	}
	if err := spec.Check(plan, cat); err != nil {
		return nil, err
	}
	return plan, nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	var c commonFlags
	c.bind(fs)
	keepRequests := fs.Bool("keep-requests", false,
		"write the per-request array to a sidecar (36x the aggregate payload; the MVP table needs none of it)")
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
	runner.KeepRequests = *keepRequests

	groupID, err := schema.GroupID(plan.Group)
	if err != nil {
		return err
	}
	groupDir := filepath.Join(c.outDir, groupID)
	if err := os.MkdirAll(groupDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", groupDir, err)
	}
	tmpDir, err := os.MkdirTemp("", "leaderboard-metrics-")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	fmt.Printf("group %s — %d candidates, %d requests at %v %s\n",
		groupID, len(plan.Runs), plan.Group.Workload.NumRequests,
		plan.Group.Workload.Load.Value, plan.Group.Workload.Load.Kind)
	if runner.KeepRequests {
		fmt.Println("keeping per-request records")
	}

	var failures int
	for _, cand := range plan.Runs {
		metricsPath := filepath.Join(tmpDir, cand.RunID+".json")
		rec, err := runner.Run(plan.Group, blisrun.RunSpec{
			RunID: cand.RunID, Deployment: cand.Deployment,
		}, metricsPath)
		if err != nil {
			// No partial record: a half-written result is worse than a missing one.
			failures++
			fmt.Fprintf(os.Stderr, "FAIL %s: %v\n", cand.RunID, err)
			continue
		}

		out := filepath.Join(groupDir, cand.RunID+".json")
		body, err := json.MarshalIndent(rec, "", " ")
		if err != nil {
			failures++
			fmt.Fprintf(os.Stderr, "FAIL %s: encode record: %v\n", cand.RunID, err)
			continue
		}
		if err := os.WriteFile(out, append(body, '\n'), 0o644); err != nil {
			failures++
			fmt.Fprintf(os.Stderr, "FAIL %s: write %s: %v\n", cand.RunID, out, err)
			continue
		}

		if runner.KeepRequests {
			payload, err := runner.RequestsPayload(metricsPath)
			if err != nil {
				failures++
				fmt.Fprintf(os.Stderr, "FAIL %s: read requests[]: %v\n", cand.RunID, err)
				continue
			}
			if payload != nil {
				sidecar := filepath.Join(groupDir, cand.RunID+".requests.json")
				if err := os.WriteFile(sidecar, append(payload, '\n'), 0o644); err != nil {
					failures++
					fmt.Fprintf(os.Stderr, "FAIL %s: write sidecar: %v\n", cand.RunID, err)
					continue
				}
			}
		}

		state := "complete"
		if !rec.Status.Complete {
			codes := make([]string, 0, len(rec.Status.Disqualifications))
			for _, d := range rec.Status.Disqualifications {
				codes = append(codes, d.Code)
			}
			state = "DISQUALIFIED " + fmt.Sprint(codes)
		}
		fmt.Printf("ok   %-22s e2e_p99=%9.1fms tokens/s=%7.1f %s\n",
			cand.RunID, rec.Metrics.E2EP99Ms, rec.Metrics.TokensPerSec, state)
	}

	if plan.Group.HorizonTicks != nil {
		fmt.Printf("note: horizon_ticks=%d bounds this group's observation window\n",
			*plan.Group.HorizonTicks)
	}
	if failures > 0 {
		return fmt.Errorf("%d of %d runs failed", failures, len(plan.Runs))
	}
	return nil
}
