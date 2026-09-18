// Package status derives a run's status from the metrics BLIS returned and the
// work that was declared. It is derived rather than asserted so it cannot be
// forgotten, and it is computed from metrics alone so it cannot be flattered.
package status

import (
	"fmt"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// Disqualification codes. Each says why a run's percentiles describe a different
// job from the one that was declared.
const (
	// CodeRequestsDropped: latencies describe only the served subset, and that
	// subset is size-biased — dropping removes the requests that did not fit.
	CodeRequestsDropped = "requests_dropped"
	// CodeRequestsTimedOut: as above, and the slowest requests are the missing ones.
	CodeRequestsTimedOut = "requests_timed_out"
	// CodeWindowEndedBusy: the horizon cut the run short.
	CodeWindowEndedBusy = "window_ended_busy"
	// CodeInjectionShort: the declared work was never fully offered.
	CodeInjectionShort = "injection_short"
	// CodeOutputTruncated: capped requests did less work than declared (A1).
	//
	// No `blis run` flag combination is known to reach this. `blis run` gives each
	// request a positive output budget, so input+budget > max_model_len drops the
	// request (../inference-sim/sim/simulator.go:575-589) rather than capping it;
	// LengthCappedRequests increments only when ProgressIndex reaches
	// max_model_len-1 despite a fitting budget (sim/simulator.go:1200). The rule is
	// kept because the counter is authoritative if it ever fires — via a workload
	// spec that omits the budget, a replay trace, or spec-decode overshoot.
	CodeOutputTruncated = "output_truncated"
)

// Warning codes: caveats that do not invalidate the numbers.
const (
	CodePreemptions = "preemptions"
	// CodeAccountingMismatch fires when upstream's injected_requests identity does
	// not hold, which means this repo's model of BLIS is wrong.
	CodeAccountingMismatch = "accounting_mismatch"
)

// Disqualification classes.
const (
	// ClassIncomplete: the declared work did not finish.
	ClassIncomplete = "incomplete"
	// ClassAltered: every request finished, but not the work that was declared.
	ClassAltered = "altered"
)

// Evaluate returns the status of a run. Rules are evaluated in a fixed order so
// two records for the same metrics are byte-identical.
func Evaluate(m schema.Metrics, g schema.Group) schema.Status {
	// The declared count comes from the spec for a workload-spec group, where the flat
	// NumRequests is a placeholder zero (schema.Workload.DeclaredRequests). `known` is
	// false when a spec drives its load from cohorts or a trace rather than a scalar
	// num_requests; the injection-short check is skipped then rather than comparing
	// against zero, which would disqualify every such run.
	declared, known := g.Workload.DeclaredRequests()
	// ofDeclared phrases "N of M" when the declared total is known, and just "N"
	// otherwise, so a spec without a scalar count does not read "of 0".
	ofDeclared := func(n int) string {
		if known {
			return fmt.Sprintf("%d of %d", n, declared)
		}
		return fmt.Sprintf("%d", n)
	}

	dqs := make([]schema.Disqualification, 0, 2)
	add := func(code, class, detail string) {
		dqs = append(dqs, schema.Disqualification{Code: code, Class: class, Detail: detail})
	}

	if m.DroppedUnservable > 0 {
		add(CodeRequestsDropped, ClassIncomplete,
			fmt.Sprintf("%s requests dropped as unservable", ofDeclared(m.DroppedUnservable)))
	}
	if m.TimedOutRequests > 0 {
		add(CodeRequestsTimedOut, ClassIncomplete,
			fmt.Sprintf("%s requests timed out before their %ds deadline",
				ofDeclared(m.TimedOutRequests), g.RequestTimeoutS))
	}
	if m.StillQueued > 0 || m.StillRunning > 0 {
		add(CodeWindowEndedBusy, ClassIncomplete,
			fmt.Sprintf("%d still queued and %d still running when the observation window closed",
				m.StillQueued, m.StillRunning))
	}
	if known && m.InjectedRequests != declared {
		add(CodeInjectionShort, ClassIncomplete,
			fmt.Sprintf("%d of %d declared requests were offered",
				m.InjectedRequests, declared))
	}
	if m.LengthCappedRequests > 0 {
		add(CodeOutputTruncated, ClassAltered,
			fmt.Sprintf("%d requests were force-completed at the max_model_len boundary",
				m.LengthCappedRequests))
	}

	warnings := make([]schema.Warning, 0, 2)
	if m.PreemptionCount > 0 {
		// CLAUDE.md calls zero preemptions healthy, but a preempted run still
		// produced complete, honest results.
		warnings = append(warnings, schema.Warning{
			Code:   CodePreemptions,
			Detail: fmt.Sprintf("%d preemptions", m.PreemptionCount),
		})
	}
	if accounted := m.CompletedRequests + m.StillQueued + m.StillRunning +
		m.DroppedUnservable + m.TimedOutRequests; accounted != m.InjectedRequests {
		warnings = append(warnings, schema.Warning{
			Code: CodeAccountingMismatch,
			Detail: fmt.Sprintf(
				"injected_requests %d != completed %d + queued %d + running %d + dropped %d + timed out %d = %d; "+
					"upstream computes injected as that sum (sim/metrics.go:102), so this record's counts are not self-consistent",
				m.InjectedRequests, m.CompletedRequests, m.StillQueued, m.StillRunning,
				m.DroppedUnservable, m.TimedOutRequests, accounted),
		})
	}

	return schema.Status{
		Complete:          len(dqs) == 0,
		Disqualifications: dqs,
		Warnings:          warnings,
	}
}
