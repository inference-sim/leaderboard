// Package schemafile embeds the canonical run record schema so the Go validator
// and the web type generator read the same bytes from the same path.
package schemafile

import _ "embed"

// Bytes is schema/run.schema.json.
//
//go:embed run.schema.json
var Bytes []byte
