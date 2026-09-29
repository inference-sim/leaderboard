package traceingest

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// SourceFormats are the trace inputs ingest accepts. "tracev2" is stored directly; "otel"
// and "weka" are converted with `blis convert` first.
var SourceFormats = []string{"tracev2", "otel", "weka"}

// ConvertOptions are the `blis convert otel|weka` knobs a user may set at ingest. They
// change the converted bytes, so they are captured implicitly in the trace's content hash
// (and recorded in provenance). Empty fields accept blis's own defaults.
type ConvertOptions struct {
	// ContextGrowth is --context-growth: "accumulate" (strict growing shared prefix) or
	// "independent".
	ContextGrowth string
	// MaxThinkTime is --max-think-time as a Go duration string (e.g. "15s"); empty leaves
	// blis's default.
	MaxThinkTime string
	// MinRounds is --min-rounds; 0 leaves blis's default (1).
	MinRounds int
	// IncludeErrors is --include-errors, honored only for otel.
	IncludeErrors bool
}

// convertTimeout bounds a conversion. Large corpora take a while to parse; this is
// generous but stops a hung convert from wedging a request.
const convertTimeout = 5 * time.Minute

// convertArgv builds the `blis convert <format>` command line. Pure, so it is tested
// without a binary. --include-errors is otel-only; --max-think-time is emitted only when
// set so blis's own default is otherwise used.
func convertArgv(binary, format, inputPath, outPrefix string, opts ConvertOptions) []string {
	a := []string{binary, "convert", format,
		"--input", inputPath,
		"--trace-output", outPrefix,
	}
	if opts.ContextGrowth != "" {
		a = append(a, "--context-growth", opts.ContextGrowth)
	}
	if opts.MaxThinkTime != "" {
		a = append(a, "--max-think-time", opts.MaxThinkTime)
	}
	if opts.MinRounds > 0 {
		a = append(a, "--min-rounds", strconv.Itoa(opts.MinRounds))
	}
	if format == "otel" && opts.IncludeErrors {
		a = append(a, "--include-errors")
	}
	return a
}

// convert runs `blis convert` from the upstream checkout (blis resolves nothing here, but
// the subprocess inherits BLIS_CATALOG like every other invocation) and returns the paths
// of the TraceV2 pair it wrote. outPrefix is a caller-owned temp path.
func convert(blisDir, binary, format, inputPath, outPrefix string, opts ConvertOptions) (header, data string, err error) {
	argv := convertArgv(binary, format, inputPath, outPrefix, opts)
	ctx, cancel := context.WithTimeout(context.Background(), convertTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = blisDir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if runErr := cmd.Run(); runErr != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", "", fmt.Errorf("blis convert %s did not finish within %s", format, convertTimeout)
		}
		return "", "", fmt.Errorf("blis convert %s rejected the input:\n%s", format, tail(stderr.String()))
	}
	// A 0 exit is meant to leave both TraceV2 files behind. Verify it did before ingest
	// tries to read them, so a convert that produced nothing (or only a header) fails with
	// an actionable message rather than a cryptic read error on an internal temp path.
	// The clean "nothing to convert" case already exits non-zero (handled above); this
	// guards the defensive gap where a 0 exit still leaves no usable data.
	header, data = outPrefix+".yaml", outPrefix+".csv"
	if err := nonEmpty(data); err != nil {
		return "", "", fmt.Errorf("blis convert %s exited without a trace data file: %w\n"+
			"the input may have contained no replayable sessions%s", format, err, stderrHint(stderr.String()))
	}
	if err := nonEmpty(header); err != nil {
		return "", "", fmt.Errorf("blis convert %s exited without a trace header file: %w%s",
			format, err, stderrHint(stderr.String()))
	}
	return header, data, nil
}

// nonEmpty reports whether path exists and holds bytes. A missing or empty file after a
// successful convert means the conversion produced no trace.
func nonEmpty(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%s was not written", filepath.Base(path))
	}
	if info.Size() == 0 {
		return fmt.Errorf("%s is empty", filepath.Base(path))
	}
	return nil
}

// stderrHint appends a convert's stderr tail when it said anything, so a warning that
// explains why the output is missing is not lost.
func stderrHint(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	return "\n" + tail(s)
}

// Request is one trace to ingest: a source format plus the input it names. For "tracev2"
// the input is the HeaderPath + DataPath pair; for "otel"/"weka" it is InputPath plus the
// convert options.
type Request struct {
	SourceFormat string
	HeaderPath   string
	DataPath     string
	InputPath    string
	Convert      ConvertOptions
}

// Ingest stores a trace by content hash and reports its corpus, running `blis convert`
// first for a raw otel/weka input. blisDir/binary are the upstream checkout and blis
// executable; they are unused for a native tracev2 input, so that path stays hermetic.
func Ingest(store Store, blisDir, binary string, req Request) (Result, error) {
	switch req.SourceFormat {
	case "tracev2":
		return IngestTraceV2(store, req.HeaderPath, req.DataPath)
	case "otel", "weka":
		tmp, err := os.MkdirTemp("", "leaderboard-convert-")
		if err != nil {
			return Result{}, fmt.Errorf("create convert temp dir: %w", err)
		}
		defer os.RemoveAll(tmp)
		header, data, err := convert(blisDir, binary, req.SourceFormat, req.InputPath, filepath.Join(tmp, "trace"), req.Convert)
		if err != nil {
			return Result{}, err
		}
		res, err := IngestTraceV2(store, header, data)
		if err != nil {
			return Result{}, err
		}
		res.SourceFormat = req.SourceFormat // record the true origin, not "tracev2"
		return res, nil
	default:
		return Result{}, fmt.Errorf("unknown trace source format %q (want one of tracev2, otel, weka)", req.SourceFormat)
	}
}

// tail returns the last of a convert's stderr, enough to carry a logrus.Fatalf line.
func tail(s string) string {
	const max = 2000
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-max:]
}
