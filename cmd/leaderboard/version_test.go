package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"testing"
)

// noEnv / fixedEnv are getenv fakes: nothing set, or one key set.
func noEnv(string) string { return "" }

// buildInfoWith returns a fake runtime/debug.ReadBuildInfo carrying the given VCS settings.
func buildInfoWith(settings ...debug.BuildSetting) func() (*debug.BuildInfo, bool) {
	return func() (*debug.BuildInfo, bool) {
		return &debug.BuildInfo{Settings: settings}, true
	}
}

// noBuildInfo stands in for a binary built without VCS stamping (ReadBuildInfo ok=false).
func noBuildInfo() (*debug.BuildInfo, bool) { return nil, false }

// noGit is a gitHead fake for a directory that is not a git checkout.
func noGit(string) (string, bool, error) { return "", false, errors.New("not a git repo") }

// noFile is a readFile fake for a missing file.
func noFile(string) ([]byte, error) { return nil, os.ErrNotExist }

// leaderboardBuildVersion: the stamped revision, shortened to 8. A modified ("dirty") tree
// gets no suffix — the plain commit is reported.
func TestLeaderboardBuildVersionReadsShortRevision(t *testing.T) {
	got := leaderboardBuildVersion(buildInfoWith(
		debug.BuildSetting{Key: "vcs.revision", Value: "0123456789abcdef"},
		debug.BuildSetting{Key: "vcs.modified", Value: "true"},
	))
	if got != "01234567" {
		t.Errorf("got %q, want 01234567 (no dirty suffix)", got)
	}
}

func TestLeaderboardBuildVersionNoStampIsEmpty(t *testing.T) {
	if got := leaderboardBuildVersion(noBuildInfo); got != "" {
		t.Errorf("got %q, want empty for an unstamped binary", got)
	}
	// Build info present but with no vcs.revision is also empty.
	if got := leaderboardBuildVersion(buildInfoWith()); got != "" {
		t.Errorf("got %q, want empty when no vcs.revision is stamped", got)
	}
}

// gitShortVersion: the commit; empty when dir is not a checkout. A modified ("dirty") tree
// gets no suffix.
func TestGitShortVersionReturnsHead(t *testing.T) {
	// Even a dirty tree reports the plain commit, no suffix.
	dirty := func(string) (string, bool, error) { return "07622594", true, nil }
	if got := gitShortVersion(dirty, "/some/dir"); got != "07622594" {
		t.Errorf("got %q, want 07622594 (no dirty suffix)", got)
	}
	if got := gitShortVersion(noGit, "/some/dir"); got != "" {
		t.Errorf("got %q, want empty for a non-checkout", got)
	}
	if got := gitShortVersion(dirty, ""); got != "" {
		t.Errorf("got %q, want empty for an empty dir", got)
	}
}

// catalogFileVersion: the trimmed contents of <catalogRoot>/VERSION; empty when absent.
func TestCatalogFileVersionReadsVERSION(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "VERSION"), []byte("def5678\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := catalogFileVersion(os.ReadFile, dir); got != "def5678" {
		t.Errorf("got %q, want def5678 (trimmed)", got)
	}
}

func TestCatalogFileVersionMissingIsEmpty(t *testing.T) {
	if got := catalogFileVersion(noFile, "/some/catalog"); got != "" {
		t.Errorf("got %q, want empty when there is no VERSION file", got)
	}
	if got := catalogFileVersion(os.ReadFile, ""); got != "" {
		t.Errorf("got %q, want empty for an empty catalog root", got)
	}
}

// resolveVersions: env var wins over auto-detect for every dependency.
func TestResolveVersionsEnvWinsOverAutoDetect(t *testing.T) {
	env := func(k string) string {
		return map[string]string{
			"LEADERBOARD_VERSION":  "v9.9.9",
			"BLIS_VERSION":         "blis-env",
			"BLIS_CATALOG_VERSION": "catalog-env",
		}[k]
	}
	// Auto-detect sources all return something different, to prove the env value is chosen.
	build := buildInfoWith(debug.BuildSetting{Key: "vcs.revision", Value: "aaaaaaaa"})
	git := func(string) (string, bool, error) { return "bbbbbbbb", false, nil }
	read := func(string) ([]byte, error) { return []byte("cccccccc"), nil }

	got := resolveVersions(env, build, git, read, "/blis", "/catalog")
	want := versions{Leaderboard: "v9.9.9", Blis: "blis-env", Catalog: "catalog-env"}
	if got != want {
		t.Errorf("env should win: got %+v, want %+v", got, want)
	}
}

// resolveVersions: with no env vars, each dependency is auto-detected from its own source.
func TestResolveVersionsAutoDetectsWhenEnvUnset(t *testing.T) {
	build := buildInfoWith(debug.BuildSetting{Key: "vcs.revision", Value: "11111111deadbeef"})
	git := func(dir string) (string, bool, error) { return "git-" + dir, false, nil }
	read := func(name string) ([]byte, error) { return []byte("from-version-file\n"), nil }

	got := resolveVersions(noEnv, build, git, read, "/blis", "/catalog")
	if got.Leaderboard != "11111111" {
		t.Errorf("leaderboard = %q, want the build stamp 11111111", got.Leaderboard)
	}
	if got.Blis != "git-/blis" {
		t.Errorf("blis = %q, want git HEAD of the blis checkout", got.Blis)
	}
	// Catalog prefers the VERSION file over git.
	if got.Catalog != "from-version-file" {
		t.Errorf("catalog = %q, want the VERSION file contents", got.Catalog)
	}
}

// resolveVersions: catalog falls back to git HEAD when there is no VERSION file (a local
// checkout that still has its .git), so dev gets auto-detection too.
func TestResolveVersionsCatalogFallsBackToGit(t *testing.T) {
	git := func(dir string) (string, bool, error) { return "catalog-git", false, nil }
	got := resolveVersions(noEnv, noBuildInfo, git, noFile, "", "/catalog")
	if got.Catalog != "catalog-git" {
		t.Errorf("catalog = %q, want the git fallback catalog-git", got.Catalog)
	}
}

// resolveVersions: nothing set and nothing detectable yields empty strings (the rail shows
// "unknown"), never a panic.
func TestResolveVersionsAllEmpty(t *testing.T) {
	got := resolveVersions(noEnv, noBuildInfo, noGit, noFile, "", "")
	if got != (versions{}) {
		t.Errorf("got %+v, want all empty", got)
	}
}

// GET /api/version returns the three dependency versions the server was built with,
// as a stable {leaderboard, blis, catalog} shape, 200 and application/json.
func TestHandleVersionServesTheServersVersions(t *testing.T) {
	s := &server{versions: versions{
		Leaderboard: "v0.1.7",
		Blis:        "07622594",
		Catalog:     "2026-09-30",
	}}

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/version", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/version: got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var got versions
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if got.Leaderboard != "v0.1.7" || got.Blis != "07622594" || got.Catalog != "2026-09-30" {
		t.Errorf("got %+v, want the three values the server was built with", got)
	}
}

// An unset variable yields "" for that key, and the key is still present, so the
// client shape is constant whether or not an operator declared the version.
func TestHandleVersionUnsetValuesAreEmptyStringsNotOmitted(t *testing.T) {
	s := &server{} // nothing declared

	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/version", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/version: got %d, want 200 (%s)", rr.Code, rr.Body.String())
	}
	// Keys present with empty values, never omitted: the footer depends on a fixed shape.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	for _, key := range []string{"leaderboard", "blis", "catalog"} {
		v, ok := raw[key]
		if !ok {
			t.Errorf("key %q missing; it must always be present", key)
			continue
		}
		if string(v) != `""` {
			t.Errorf("key %q = %s, want \"\" for an unset version", key, v)
		}
	}
}
