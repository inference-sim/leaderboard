// Package hardware reads BLIS's hardware catalogue so an authoring mistake — a
// name that does not exist, or two names for the same accelerator — is caught
// before a run rather than discovered as a duplicate row.
//
// Since blis v0.10.0 (#1851) hardware is no longer a single hardware_config.json;
// it lives in the blis-catalog as one YAML file per accelerator under hardware/,
// named by file (h100.yaml -> "h100"). A scenario selects a chip by that name in
// its cluster.hardware field, and the kernel prices the run from the file's spec.
package hardware

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// Dir returns the hardware directory within a blis-catalog clone root. The catalog
// root is BLIS_CATALOG; blis resolves <catalog>/hardware/<name>.yaml with no default.
func Dir(catalogRoot string) string {
	return filepath.Join(catalogRoot, "hardware")
}

// Catalog is the set of hardware names BLIS knows, with the numeric spec of each.
type Catalog struct {
	specs map[string]map[string]any
}

// Load reads every <dir>/*.yaml accelerator file, keyed by file basename. Keys
// prefixed with "_comment" are prose, not spec, and are dropped — the catalog files
// carry provenance and interconnect notes as "_comment*" keys alongside the numbers.
func Load(dir string) (*Catalog, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("hardware: read %s: %w", dir, err)
	}

	c := &Catalog{specs: make(map[string]map[string]any, len(entries))}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("hardware: read %s: %w", path, err)
		}
		var spec map[string]any
		if err := yaml.Unmarshal(raw, &spec); err != nil {
			return nil, fmt.Errorf("hardware: parse %s: %w", path, err)
		}
		for k := range spec {
			if strings.HasPrefix(k, "_comment") {
				delete(spec, k)
			}
		}
		name := strings.TrimSuffix(e.Name(), ".yaml")
		c.specs[name] = spec
	}
	if len(c.specs) == 0 {
		return nil, fmt.Errorf("hardware: %s contains no hardware entries", dir)
	}
	return c, nil
}

// Known reports whether name is a hardware entry BLIS would accept.
func (c *Catalog) Known(name string) bool {
	_, ok := c.specs[name]
	return ok
}

// Names returns every hardware name, sorted.
func (c *Catalog) Names() []string {
	out := make([]string, 0, len(c.specs))
	for name := range c.specs {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Aliases returns the other names whose numeric spec is identical to name's. Two
// such names are one accelerator, so running both produces a duplicate row rather
// than a second candidate.
func (c *Catalog) Aliases(name string) []string {
	spec, ok := c.specs[name]
	if !ok {
		return nil
	}
	key, err := schema.CanonicalJSON(spec)
	if err != nil {
		return nil
	}

	var out []string
	for other, otherSpec := range c.specs {
		if other == name {
			continue
		}
		otherKey, err := schema.CanonicalJSON(otherSpec)
		if err != nil {
			continue
		}
		if string(key) == string(otherKey) {
			out = append(out, other)
		}
	}
	sort.Strings(out)
	return out
}

// Entry is one accelerator the way the Catalog page shows it: its name, blis's
// numeric spec, and the other names whose spec is byte-identical (aliases — one
// accelerator, not a rival candidate).
type Entry struct {
	Name    string         `json:"name"`
	Aliases []string       `json:"aliases"`
	Spec    map[string]any `json:"spec"`
}

// Entries returns every hardware entry, sorted by name, exposing the parsed specs
// the Catalog page renders. It reuses Names and Aliases so the sort order and the
// alias grouping cannot drift from what the run-time checks already use.
func (c *Catalog) Entries() []Entry {
	names := c.Names()
	out := make([]Entry, 0, len(names))
	for _, name := range names {
		// Aliases returns nil for an accelerator with none; send [] rather than a nil slice
		// so the JSON is "aliases":[] not null, and the client never has to guard a spread.
		aliases := c.Aliases(name)
		if aliases == nil {
			aliases = []string{}
		}
		out = append(out, Entry{
			Name:    name,
			Aliases: aliases,
			Spec:    c.specs[name],
		})
	}
	return out
}
