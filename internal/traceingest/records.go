package traceingest

// Reading a stored trace back as JSON for the Saved-workloads "view trace as JSON" panel: the
// header (parsed from header.yaml) plus a bounded sample of records (data.csv rows as JSON
// objects). A real corpus is tens of thousands of records, so the sample is capped and the
// full count is reported separately, letting the panel say "first N of M".

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"strconv"

	"gopkg.in/yaml.v3"
)

const (
	defaultRecordLimit = 50  // records returned when the caller names no limit
	maxRecordLimit     = 500 // hard cap, so a huge ?limit cannot blow the payload up
)

// Records is a trace's header and a sample of its records, as JSON-ready values, matching the
// web TraceRecords interface.
type Records struct {
	Header       map[string]any   `json:"header"`
	TotalRecords int              `json:"total_records"`
	Limit        int              `json:"limit"`
	Records      []map[string]any `json:"records"`
}

// RecordsFromFiles parses the trace header (YAML) and up to limit data rows (CSV) into JSON-
// ready maps, counting the whole corpus so the panel can say "first N of M". A row becomes a
// map keyed by column name with best-effort typed values (number, bool, else string); an empty
// cell is omitted so the sample stays compact. limit <= 0 uses the default; it is capped.
func RecordsFromFiles(headerBytes, dataBytes []byte, limit int) (Records, error) {
	if limit <= 0 {
		limit = defaultRecordLimit
	}
	if limit > maxRecordLimit {
		limit = maxRecordLimit
	}

	out := Records{Header: map[string]any{}, Records: []map[string]any{}, Limit: limit}
	if len(headerBytes) > 0 {
		if err := yaml.Unmarshal(headerBytes, &out.Header); err != nil {
			return Records{}, fmt.Errorf("parse trace header: %w", err)
		}
	}

	r := csv.NewReader(bytes.NewReader(dataBytes))
	r.FieldsPerRecord = -1 // trace CSVs are wide and may vary; do not enforce a column count
	head, err := r.Read()
	if err == io.EOF {
		return out, nil
	}
	if err != nil {
		return Records{}, fmt.Errorf("parse CSV header: %w", err)
	}

	total := 0
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Records{}, fmt.Errorf("parse CSV row %d: %w", total+1, err)
		}
		total++
		if len(out.Records) < limit {
			rec := make(map[string]any, len(head))
			for i, name := range head {
				if i >= len(row) || row[i] == "" {
					continue
				}
				rec[name] = typedCell(row[i])
			}
			out.Records = append(out.Records, rec)
		}
	}
	out.TotalRecords = total
	return out, nil
}

// typedCell gives a CSV cell its natural JSON type so the viewer shows numbers as numbers and
// booleans as booleans, not everything quoted: a bool, then an integer, then a float, else the
// original string.
func typedCell(s string) any {
	switch s {
	case "true":
		return true
	case "false":
		return false
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	return s
}
