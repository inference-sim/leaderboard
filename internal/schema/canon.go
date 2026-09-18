package schema

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

// idHexLen is how much of the sha256 digest becomes a group_id or work_id. Twelve
// hex characters is 48 bits: enough that a collision across a repo's worth of
// declared groups is not a practical concern, short enough to read in a path.
const idHexLen = 12

// CanonicalJSON encodes v so that two values describing the same declared work
// produce identical bytes: object keys sorted lexicographically, no insignificant
// whitespace, and numbers exactly as encoding/json renders them.
//
// The number rule is deliberate. Marshalling and re-decoding with UseNumber keeps
// each number's Go-rendered literal ("6" for float64(6.0), "500" for int 500)
// without needing to know the field's declared type. It differs from Python's
// json.dumps, which renders 6.0 as "6.0" — which is why the design-time ids in
// prototypes/README.md were recomputed rather than preserved.
func CanonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("canonical: marshal: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, fmt.Errorf("canonical: decode: %w", err)
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, tree); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		buf.WriteString(t.String())
	case string:
		enc, err := json.Marshal(t)
		if err != nil {
			return fmt.Errorf("canonical: string: %w", err)
		}
		buf.Write(enc)
	case []any:
		buf.WriteByte('[')
		for i, el := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, el); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			enc, err := json.Marshal(k)
			if err != nil {
				return fmt.Errorf("canonical: key %q: %w", k, err)
			}
			buf.Write(enc)
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
	return nil
}

// ShortHash is the content id of v: the first idHexLen hex characters of the
// sha256 of its canonical encoding.
func ShortHash(v any) (string, error) {
	b, err := CanonicalJSON(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:idHexLen], nil
}

// SpecSHA256 is the content hash of an inline workload spec: the full sha256 of its
// canonical encoding, hex-encoded. Unlike a group_id (idHexLen chars), this is the
// whole digest, because it is stored as the record's spec_sha256 and folded into
// group_id — a collision here would silently merge two different workloads into one
// table. The hash is over the spec verbatim (canonicalised, not blis-normalised), so
// two equivalent spellings are two workloads; identical content is one.
func SpecSHA256(spec any) (string, error) {
	b, err := CanonicalJSON(spec)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// GroupID identifies one comparability group. Changing any field of g — the seed
// included (A2) — makes a different group, which means a different table.
func GroupID(g Group) (string, error) {
	return ShortHash(g)
}

// WorkID identifies the work offered with the seed removed, so a later variance
// view can aggregate a group's replicates without a schema change (A2).
func WorkID(g Group) (string, error) {
	m, err := asMap(g)
	if err != nil {
		return "", err
	}
	delete(m, "seed")
	return ShortHash(m)
}

func asMap(v any) (map[string]any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("asMap: marshal: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("asMap: decode: %w", err)
	}
	return m, nil
}
