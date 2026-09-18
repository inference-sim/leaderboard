package schema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	schemafile "github.com/inference-sim/leaderboard/schema"
)

const schemaURL = "https://github.com/inference-sim/leaderboard/schema/run.schema.json"

var (
	compileOnce sync.Once
	compiled    *jsonschema.Schema
	compileErr  error
)

func compiledSchema() (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemafile.Bytes))
		if err != nil {
			compileErr = fmt.Errorf("schema: parse run.schema.json: %w", err)
			return
		}
		c := jsonschema.NewCompiler()
		if err := c.AddResource(schemaURL, doc); err != nil {
			compileErr = fmt.Errorf("schema: add resource: %w", err)
			return
		}
		compiled, compileErr = c.Compile(schemaURL)
	})
	return compiled, compileErr
}

// Validate checks one record's JSON against the canonical schema. A failure names
// the offending field path, because "invalid record" is not an actionable message
// when a record has 27 required metrics.
func Validate(raw []byte) error {
	sch, err := compiledSchema()
	if err != nil {
		return err
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("schema: parse record: %w", err)
	}
	if err := sch.Validate(inst); err != nil {
		return fmt.Errorf("schema: %w", err)
	}
	return nil
}

// ValidateRecord marshals r and validates the result, so the runner cannot write a
// record that the reader would reject.
func ValidateRecord(r Record) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("schema: marshal record: %w", err)
	}
	return Validate(raw)
}

// RequiredCoreNames returns the metric names the schema requires, read from the
// schema document itself so internal/drift compares upstream against the contract
// rather than against a second hand-maintained list.
func RequiredCoreNames() ([]string, error) {
	var doc struct {
		Defs struct {
			Metrics struct {
				Required []string `json:"required"`
			} `json:"metrics"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(schemafile.Bytes, &doc); err != nil {
		return nil, fmt.Errorf("schema: read required core: %w", err)
	}
	if len(doc.Defs.Metrics.Required) == 0 {
		return nil, fmt.Errorf("schema: $defs.metrics.required is empty")
	}
	return doc.Defs.Metrics.Required, nil
}
