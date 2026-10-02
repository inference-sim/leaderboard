package main

import (
	"net/http"
	"path/filepath"
	"runtime/debug"
	"strings"
)

// versions is the deployment-level provenance the web nav rail shows: which build of
// each first-party dependency this running server is made of. Each string is resolved at
// serve startup (resolveVersions) and is opaque to the server once set — no parsing, no
// validation — so an operator may write a tag (v1.2.3), a commit (abc1234), a date, or any
// combination.
//
// Precedence per dependency: an explicit env var (declared, trusted verbatim), else an
// auto-detected value (the binary's build VCS stamp, the blis checkout's git HEAD, the
// catalog's VERSION file / git HEAD), else "" — which the rail renders as "unknown". The
// env var always wins, so an operator can override a stale or missing auto-detect.
//
// Auto-detected or declared, these are DECLARED-grade, not verified: nothing proves the
// string matches the artifact actually serving (an env var can be wrong; a build stamp can
// outlive a hot-swapped catalog). This is display-only, deployment-level provenance; it is
// not per-run provenance, and does not touch the existing RunRecord.provenance.blis_commit,
// which blis still records per run.
type versions struct {
	Leaderboard string `json:"leaderboard"`
	Blis        string `json:"blis"`
	Catalog     string `json:"catalog"`
}

// resolveVersions fills each dependency's version, preferring the explicit env var, then an
// auto-detected value, then "". The detection sources are injected (getenv, buildInfo,
// gitHead, readFile) so cmdServe wires the real os / build-info / git sources and a test
// supplies fakes without a real environment, checkout, or filesystem.
func resolveVersions(
	getenv func(string) string,
	buildInfo func() (*debug.BuildInfo, bool),
	gitHead func(string) (string, bool, error),
	readFile func(string) ([]byte, error),
	blisDir, catalogRoot string,
) versions {
	return versions{
		// This binary: the VCS revision Go stamps in at build time (zero-config for a
		// `go build` from a git checkout). An image whose source tree had its .git stripped
		// carries no stamp, so there the operator sets LEADERBOARD_VERSION.
		Leaderboard: firstNonEmpty(getenv("LEADERBOARD_VERSION"), leaderboardBuildVersion(buildInfo)),
		// blis: the commit of the bundled checkout, the same git provenance a run records. The
		// image ships blis's .git for exactly that, so this works at runtime.
		Blis: firstNonEmpty(getenv("BLIS_VERSION"), gitShortVersion(gitHead, blisDir)),
		// catalog: the VERSION file build.sh bundles (its .git is stripped from the image),
		// falling back to git HEAD for a local checkout that still has one.
		Catalog: firstNonEmpty(
			getenv("BLIS_CATALOG_VERSION"),
			catalogFileVersion(readFile, catalogRoot),
			gitShortVersion(gitHead, catalogRoot),
		),
	}
}

// firstNonEmpty returns the first argument that is not the empty string, or "" if all are.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// leaderboardBuildVersion reads the VCS revision Go stamps into the binary when it is built
// from a git checkout (go build / go install, buildvcs on), shortened to 8 chars. It returns
// "" when no VCS info was stamped — e.g. an image built from a source tree with .git stripped.
func leaderboardBuildVersion(buildInfo func() (*debug.BuildInfo, bool)) string {
	info, ok := buildInfo()
	if !ok {
		return ""
	}
	var rev string
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" {
			rev = s.Value
		}
	}
	if rev == "" {
		return ""
	}
	if len(rev) > 8 {
		rev = rev[:8]
	}
	return rev
}

// gitShortVersion is the short commit of the checkout at dir, via the same git provenance a
// run records (its dirty flag is ignored here — the plain commit is reported). It returns ""
// when dir is empty or not a readable git checkout, so a stripped-.git image falls through to
// the next source rather than erroring.
func gitShortVersion(gitHead func(string) (string, bool, error), dir string) string {
	if dir == "" {
		return ""
	}
	head, _, err := gitHead(dir)
	if err != nil || head == "" {
		return ""
	}
	return head
}

// catalogFileVersion reads a VERSION file at the catalog root — written by deploy/openshift/
// build.sh with the ref it cloned, so a deployment whose catalog had its .git stripped still
// reports a version. It returns "" when there is no catalog root or no VERSION file.
func catalogFileVersion(readFile func(string) ([]byte, error), catalogRoot string) string {
	if catalogRoot == "" {
		return ""
	}
	b, err := readFile(filepath.Join(catalogRoot, "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// handleVersion serves the three dependency versions as a stable
// {"leaderboard": ..., "blis": ..., "catalog": ...} shape. An unresolved dependency yields ""
// for that key — never omitted — so the client's shape is constant.
//
// A dedicated endpoint, deliberately not folded into /api/results: the static,
// server-less build simply does not have it, and the versions are omitted beside the rail
// links when the request 404s (see web/src/components/RailVersion).
func (s *server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.versions)
}
