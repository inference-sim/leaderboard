// Package hardware reads BLIS's hardware catalogue so an authoring mistake — a
// name that does not exist, or two names for the same accelerator — is caught
// before a run rather than discovered as a duplicate row.
package hardware

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/inference-sim/leaderboard/internal/schema"
)

// DefaultConfigPath is where the catalogue lives relative to this repo's root.
const DefaultConfigPath = "../inference-sim/hardware_config.json"

// Catalog is the set of hardware names BLIS knows, with the numeric spec of each.
type Catalog struct {
	specs map[string]map[string]any
}

// Load reads hardware_config.json. Keys prefixed with "_comment" are prose, not
// hardware, and are dropped — including at the top level, where the trimmed
// testdata copy carries its own provenance note.
func Load(path string) (*Catalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("hardware: read %s: %w", path, err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("hardware: parse %s: %w", path, err)
	}

	c := &Catalog{specs: make(map[string]map[string]any, len(doc))}
	for name, body := range doc {
		if strings.HasPrefix(name, "_comment") {
			continue
		}
		var spec map[string]any
		if err := json.Unmarshal(body, &spec); err != nil {
			return nil, fmt.Errorf("hardware: parse %s entry %q: %w", path, name, err)
		}
		for k := range spec {
			if strings.HasPrefix(k, "_comment") {
				delete(spec, k)
			}
		}
		c.specs[name] = spec
	}
	if len(c.specs) == 0 {
		return nil, fmt.Errorf("hardware: %s contains no hardware entries", path)
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
