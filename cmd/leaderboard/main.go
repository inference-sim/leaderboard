// Command leaderboard produces and checks the results this repo ranks.
//
//	leaderboard run       execute runs.yaml, write results/<group_id>/<run_id>.json
//	leaderboard serve     HTTP API the web app uses to run candidates and read results
//	leaderboard validate  check runs.yaml, every stored result, and upstream drift
//	leaderboard verify    re-run stored results and diff; BLIS is deterministic, so a
//	                      difference with no flag change is a bug worth chasing
package main

import (
	"fmt"
	"os"
)

const usage = `leaderboard — collect and check BLIS results

usage:
  leaderboard run      [-runs runs.yaml] [-out DIR] [-blis ../inference-sim] [-keep-requests]
  leaderboard serve    [-out DIR] [-blis ../inference-sim] [-addr :8080]
  leaderboard validate [-runs runs.yaml] [-out DIR] [-blis ../inference-sim]
  leaderboard verify   [-runs runs.yaml] [-out DIR] [-blis ../inference-sim] [-run ID]

-out is where results are read and written. It defaults to $LEADERBOARD_RESULTS, or
~/leaderboard-results when that is unset; an explicit -out overrides both. Point
$LEADERBOARD_RESULTS at the repo's results/ for local dev, or at a persistent volume
in a container.

blis is always executed with its own checkout as the working directory: it resolves
defaults.yaml, hardware_config.json and model_configs/ relative to cwd.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "serve":
		err = cmdServe(os.Args[2:])
	case "validate":
		err = cmdValidate(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "leaderboard: %v\n", err)
		os.Exit(1)
	}
}
