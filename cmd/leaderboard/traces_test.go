package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inference-sim/leaderboard/internal/traceingest"
)

const testHeader = "trace_version: 3\ntime_unit: microseconds\nmode: generated\nwarm_up_requests: 0\nsession_context_growth: accumulate\n"
const testCSV = "request_id,session_id,round_index,input_tokens,output_tokens,arrival_time_us\n0,aaaa,0,418,20,0\n1,aaaa,1,50213,146,64000\n2,bbbb,0,900,30,10000\n"

// A native TraceV2 upload is ingested without blis: the handler stores the blob and
// reports the corpus the trace card needs.
func TestHandleTraceIngestTraceV2(t *testing.T) {
	dir := t.TempDir()
	s := &server{outDir: dir, blisDir: dir, traceStore: traceingest.Store(filepath.Join(dir, "traces"))}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("source_format", "tracev2")
	hw, _ := mw.CreateFormFile("header", "in.yaml")
	hw.Write([]byte(testHeader))
	dw, _ := mw.CreateFormFile("data", "in.csv")
	dw.Write([]byte(testCSV))
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/traces", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	s.handleTraceIngest(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	var got struct {
		SHA256               string `json:"sha256"`
		Records              int    `json:"records"`
		Sessions             int    `json:"sessions"`
		SessionContextGrowth string `json:"session_context_growth"`
		SourceFormat         string `json:"source_format"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("response not JSON: %v (%s)", err, rr.Body.String())
	}
	if got.SHA256 == "" || got.Records != 3 || got.Sessions != 2 {
		t.Errorf("ingest result = %+v, want sha set, 3 records, 2 sessions", got)
	}
	if got.SessionContextGrowth != "accumulate" || got.SourceFormat != "tracev2" {
		t.Errorf("ingest result = %+v", got)
	}
	if !s.traceStore.Has(got.SHA256) {
		t.Error("blob not written to the store")
	}
}

func TestHandleTraceIngestRejectsUnknownFormat(t *testing.T) {
	dir := t.TempDir()
	s := &server{outDir: dir, blisDir: dir, traceStore: traceingest.Store(filepath.Join(dir, "traces"))}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("source_format", "csvish")
	fw, _ := mw.CreateFormFile("header", "in.yaml")
	fw.Write([]byte(testHeader))
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/traces", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	s.handleTraceIngest(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown format", rr.Code)
	}
}

// A multi-node trace is refused at ingest (replay cannot reproduce it).
func TestHandleTraceIngestRefusesMultiNode(t *testing.T) {
	dir := t.TempDir()
	s := &server{outDir: dir, blisDir: dir, traceStore: traceingest.Store(filepath.Join(dir, "traces"))}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("source_format", "tracev2")
	hw, _ := mw.CreateFormFile("header", "in.yaml")
	hw.Write([]byte(testHeader + "max_nodes_spanned: 3\n"))
	dw, _ := mw.CreateFormFile("data", "in.csv")
	dw.Write([]byte(testCSV))
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/traces", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	s.handleTraceIngest(rr, req)
	if rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for a multi-node trace (body %s)", rr.Code, rr.Body.String())
	}
}

// An upload past the configured limit is refused with 413 and an actionable message,
// not buffered. A tiny limit stands in for a huge trace.
func TestHandleTraceIngestRejectsOversized(t *testing.T) {
	dir := t.TempDir()
	s := &server{outDir: dir, blisDir: dir, traceStore: traceingest.Store(filepath.Join(dir, "traces")), maxUploadBytes: 64}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("source_format", "weka")
	fw, _ := mw.CreateFormFile("input", "big.jsonl")
	fw.Write(bytes.Repeat([]byte("x"), 4096)) // well past the 64-byte limit
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/traces", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	s.handleTraceIngest(rr, req)

	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 (body %s)", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "max-upload-mb") {
		t.Errorf("message should point at the configurable limit, got %s", rr.Body.String())
	}
}

// A JSONL weka upload must be staged with its .jsonl extension, because blis decides
// line-split (JSONL) vs single-object (JSON) purely by extension. The stub blis accepts
// the input only when it ends in .jsonl, so this fails if the handler strips the extension.
func TestHandleTraceIngestPreservesJSONLExtension(t *testing.T) {
	blisDir := t.TempDir()
	stub := "#!/bin/sh\ninput=\"\"; prefix=\"\"\n" +
		"while [ $# -gt 0 ]; do case \"$1\" in --input) shift; input=\"$1\";; --trace-output) shift; prefix=\"$1\";; esac; shift; done\n" +
		"case \"$input\" in *.jsonl) ;; *) echo \"input not jsonl: $input\" >&2; exit 1;; esac\n" +
		"printf 'trace_version: 3\\ntime_unit: microseconds\\nmode: generated\\nwarm_up_requests: 0\\n' > \"$prefix.yaml\"\n" +
		"printf 'request_id,session_id,input_tokens,output_tokens,arrival_time_us\\n0,s1,10,5,0\\n' > \"$prefix.csv\"\n"
	if err := os.WriteFile(filepath.Join(blisDir, "blis"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &server{outDir: blisDir, blisDir: blisDir, traceStore: traceingest.Store(filepath.Join(blisDir, "traces"))}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("source_format", "weka")
	fw, _ := mw.CreateFormFile("input", "sessions.jsonl")
	fw.Write([]byte(`{"a":1}` + "\n" + `{"a":2}` + "\n"))
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/traces", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	s.handleTraceIngest(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
}
