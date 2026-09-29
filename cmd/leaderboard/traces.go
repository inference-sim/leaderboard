package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/inference-sim/leaderboard/internal/traceingest"
)

// defaultMaxUpload caps a trace upload when the server sets no explicit limit. Real Weka
// and OTel corpora are far larger than the tens of MB a converted TraceV2 comes to, so the
// default is generous; ops can raise or lower it with -max-upload-mb (§14 O1). It bounds
// the total request body, not the memory used — large parts spill to disk (below).
const defaultMaxUpload = 1 << 30 // 1 GiB

// uploadMemoryBudget is how much of a multipart upload ParseMultipartForm keeps in memory
// before spilling the rest to a temp file. Small on purpose: a multi-hundred-MB trace must
// not be buffered in RAM, so anything past this lands on disk and is streamed from there.
const uploadMemoryBudget = 32 << 20 // 32 MiB

// uploadLimit is the total request-body cap: the configured value, or the default when the
// server set none (including tests that build a server literal).
func (s *server) uploadLimit() int64 {
	if s.maxUploadBytes > 0 {
		return s.maxUploadBytes
	}
	return defaultMaxUpload
}

// handleTraceIngest accepts a multipart trace upload, stores it in the hash-addressed
// trace store (converting a raw OTel/Weka input with `blis convert` first), and returns
// what a trace workload profile needs: the content hash, corpus size, and the trace's
// session_context_growth. The web trace card posts here, then creates a workload profile
// referencing the returned sha256 via POST /api/workloads (the trace-shaped analog of
// pasting spec YAML into the spec card).
//
// Fields: source_format ("tracev2" | "otel" | "weka"); for tracev2 the files "header" and
// "data"; for otel/weka the file "input" plus optional convert knobs (context_growth,
// max_think_time, min_rounds, include_errors).
func (s *server) handleTraceIngest(w http.ResponseWriter, r *http.Request) {
	limit := s.uploadLimit()
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	// A small in-memory budget: parts larger than this spill to a temp file, so a big
	// trace is streamed from disk rather than held in RAM.
	if err := r.ParseMultipartForm(uploadMemoryBudget); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf(
				"the upload exceeds the %d MiB limit. Raise it with -max-upload-mb (or "+
					"$LEADERBOARD_MAX_UPLOAD_MB) on `leaderboard serve`, or convert the trace with "+
					"`blis convert` and upload the smaller TraceV2 pair instead of the raw file.",
				limit>>20))
			return
		}
		httpError(w, http.StatusBadRequest, fmt.Sprintf("could not read the upload: %v", err))
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	format := r.FormValue("source_format")
	tmp, err := os.MkdirTemp("", "leaderboard-upload-")
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.RemoveAll(tmp)

	req := traceingest.Request{SourceFormat: format}
	switch format {
	case "tracev2":
		hp, err := saveUpload(r, "header", tmp, "header", ".yaml")
		if err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		dp, err := saveUpload(r, "data", tmp, "data", ".csv")
		if err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		req.HeaderPath, req.DataPath = hp, dp
	case "otel", "weka":
		// blis decides JSONL (line-split) vs single-JSON purely by extension, so the
		// staged file must keep the upload's extension. Weka is line-oriented, so a
		// missing extension defaults to .jsonl; otel may be either, defaulting to .json.
		fallback := ".json"
		if format == "weka" {
			fallback = ".jsonl"
		}
		ip, err := saveUpload(r, "input", tmp, "input", fallback)
		if err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		req.InputPath = ip
		req.Convert = traceingest.ConvertOptions{
			ContextGrowth: r.FormValue("context_growth"),
			MaxThinkTime:  r.FormValue("max_think_time"),
			IncludeErrors: r.FormValue("include_errors") == "true",
		}
		if mr := r.FormValue("min_rounds"); mr != "" {
			if n, err := strconv.Atoi(mr); err == nil {
				req.Convert.MinRounds = n
			}
		}
	default:
		httpError(w, http.StatusBadRequest,
			fmt.Sprintf("source_format %q must be one of tracev2, otel, weka", format))
		return
	}

	res, err := traceingest.Ingest(s.traceStore, s.blisDir, "./blis", req)
	if err != nil {
		// A refusal (multi-node, a convert blis rejected) is the caller's input, not a
		// server fault: surface it so the trace card can show it, like a spec error.
		httpError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sha256":                 res.SHA256,
		"records":                res.Records,
		"sessions":               res.Sessions,
		"session_context_growth": res.SessionContextGrowth,
		"source_format":          res.SourceFormat,
	})
}

// saveUpload writes the named multipart file part into dir as <base><ext> and returns its
// path, preserving the upload's own extension (falling back to fallbackExt when the
// uploaded name has none). The extension is load-bearing: `blis convert` chooses JSONL
// line-splitting vs single-JSON parsing by it, so staging a `.jsonl` upload as an
// extensionless file would make blis misread every line after the first. A missing part is
// a bad request naming the field.
func saveUpload(r *http.Request, field, dir, base, fallbackExt string) (string, error) {
	f, hdr, err := r.FormFile(field)
	if err != nil {
		return "", fmt.Errorf("missing the %q file in the upload", field)
	}
	defer f.Close()
	ext := filepath.Ext(hdr.Filename)
	if ext == "" {
		ext = fallbackExt
	}
	dest := filepath.Join(dir, base+ext)
	out, err := os.Create(dest)
	if err != nil {
		return "", fmt.Errorf("stage upload: %w", err)
	}
	defer out.Close()
	if _, err := io.Copy(out, f); err != nil {
		return "", fmt.Errorf("stage upload %q: %w", field, err)
	}
	return dest, nil
}
