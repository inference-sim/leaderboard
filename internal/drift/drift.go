// Package drift asserts that this repo's required-core metric list still matches
// upstream's sim.MetricsOutput.
//
// It parses the upstream *source* with go/ast rather than importing the module.
// That keeps ../inference-sim a read-only sibling: no replace directive, no shared
// go.mod, no build failure here when upstream's dependencies move. The cost is that
// a rename upstream shows up as a text diff rather than a compile error, which is
// exactly what the test below turns back into a loud failure.
package drift

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// DefaultMetricsPath is where upstream's MetricsOutput lives, relative to this
// repo's root.
const DefaultMetricsPath = "../inference-sim/sim/metrics_utils.go"

// RequiredJSONFields returns the contract names of typeName's fields that
// encoding/json always emits, in declaration order. That matches encoding/json's
// own behavior, not just its json-tagged fields: a field is included when it is
// exported (its Go name starts with an uppercase letter), is not tagged
// `json:"-"`, and does not carry the omitempty option. Its name is the json tag's
// name when that name is non-empty, and otherwise the Go field name — because
// encoding/json falls back to the Go name for an untagged field, for a tag with no
// json key, and for a tag of the form `json:","` (an omitempty-only tag with no
// name). Unexported fields are excluded, since encoding/json never emits them.
//
// An anonymous embedded field without a json tag name is rejected with an error:
// encoding/json promotes its inner fields into the enclosing object, and resolving
// that would mean following the embedded type across files, which this package
// does not do. An embedded field that does carry a json tag name is treated as an
// ordinary named field, since a name suppresses promotion.
func RequiredJSONFields(path, typeName string) ([]string, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, fmt.Errorf("drift: parse %s: %w", path, err)
	}

	var st *ast.StructType
	ast.Inspect(f, func(n ast.Node) bool {
		if st != nil {
			return false
		}
		ts, ok := n.(*ast.TypeSpec)
		if !ok || ts.Name == nil || ts.Name.Name != typeName {
			return true
		}
		if s, ok := ts.Type.(*ast.StructType); ok {
			st = s
		}
		return false
	})
	if st == nil {
		return nil, fmt.Errorf("drift: %s declares no struct type %s", path, typeName)
	}

	var out []string
	for _, field := range st.Fields.List {
		var tagValue string
		if field.Tag != nil {
			var err error
			tagValue, err = strconv.Unquote(field.Tag.Value)
			if err != nil {
				return nil, fmt.Errorf("drift: %s: unquote tag %s: %w", typeName, field.Tag.Value, err)
			}
		}
		jsonTag := reflect.StructTag(tagValue).Get("json")
		dashed := jsonTag == "-"
		parts := strings.Split(jsonTag, ",")
		tagName := parts[0]
		omitempty := false
		for _, opt := range parts[1:] {
			if opt == "omitempty" {
				omitempty = true
			}
		}

		if len(field.Names) == 0 {
			// Anonymous embedded field. A json tag with an explicit name suppresses
			// encoding/json's promotion of the embedded type's fields, so it behaves
			// like an ordinary named field named after that tag.
			if dashed {
				continue
			}
			if tagName != "" {
				if !omitempty {
					out = append(out, tagName)
				}
				continue
			}
			return nil, fmt.Errorf(
				"drift: %s: embedded field %s (type %s) has no json tag name; "+
					"encoding/json promotes its fields into the enclosing object, "+
					"and this package cannot follow types across files to resolve them",
				typeName, exprString(field.Type), exprString(field.Type))
		}

		for _, name := range field.Names {
			if !name.IsExported() {
				continue // encoding/json never emits an unexported field
			}
			if dashed || omitempty {
				continue
			}
			contractName := tagName
			if contractName == "" {
				contractName = name.Name
			}
			out = append(out, contractName)
		}
	}
	return out, nil
}

// exprString renders a type expression back to source text, for error messages
// naming an unsupported embedded field's type. It covers the forms an embedded
// field can actually take (a plain name, a pointer to one, or a qualified name
// from another package) rather than the full expression grammar.
func exprString(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.StarExpr:
		return "*" + exprString(e.X)
	case *ast.SelectorExpr:
		return exprString(e.X) + "." + e.Sel.Name
	default:
		return fmt.Sprintf("%T", expr)
	}
}

// Compare reports the difference between upstream's always-emitted fields and the
// fields the schema requires. Both directions matter: a new upstream field means the
// schema is incomplete, and a vanished one means the schema requires something BLIS
// no longer emits, which would reject every future run.
func Compare(upstream, contract []string) error {
	inContract := map[string]bool{}
	for _, n := range contract {
		inContract[n] = true
	}
	inUpstream := map[string]bool{}
	for _, n := range upstream {
		inUpstream[n] = true
	}

	var added, removed []string
	for _, n := range upstream {
		if !inContract[n] {
			added = append(added, n)
		}
	}
	for _, n := range contract {
		if !inUpstream[n] {
			removed = append(removed, n)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)

	if len(added) == 0 && len(removed) == 0 {
		return nil
	}
	var b strings.Builder
	if len(added) > 0 {
		fmt.Fprintf(&b, "upstream always emits %d field(s) the schema does not require: %s. "+
			"Add them to $defs.metrics in schema/run.schema.json and to schema.Metrics.\n",
			len(added), strings.Join(added, ", "))
	}
	if len(removed) > 0 {
		fmt.Fprintf(&b, "the schema requires %d field(s) upstream no longer always emits: %s. "+
			"Every future run would be rejected until they are made optional.\n",
			len(removed), strings.Join(removed, ", "))
	}
	return fmt.Errorf("%s", strings.TrimRight(b.String(), "\n"))
}
