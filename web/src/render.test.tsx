import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadWorkloads } from './load'
import type { RunRecord } from './load'
import { ReadoutTable } from './components/ReadoutTable'
import { SortNote } from './components/SortNote'
import { ReproPanel } from './components/ReproPanel'
import { WorkloadHeader } from './components/SpecHeader'
import { NewRun } from './components/NewRun'
import { initialValues } from './newrun'

/**
 * Stands in for the manual "npm run dev, confirm by eye" step: an agent cannot look
 * at a browser, so this renders the same components to static markup with
 * `react-dom/server` (no DOM required) and asserts against the committed fixture.
 *
 * A table is one workload spanning every model and hardware run against it (E1), with
 * model and hardware as row filters and no automatic best-markers (E4, E5). The fixture
 * is a single model, so a second model against the same work is synthesised — by
 * changing the deployment's model, which (model having left the group key) leaves the
 * group_id unchanged, so the two models merge into one table.
 *
 * Not covered here: the header-click sort interaction. `renderToStaticMarkup` has no
 * event loop; `sortRecords` itself is covered by model.test.ts (including across models).
 */

const MAIN = '5063e40dceb2' // the unbounded qwen/qwen3-14b workload, 11 records
const HORIZON = '6beca76a8f45' // the bounded-window lone disqualified run

const records = fixture as unknown as RunRecord[]
const workloads = loadWorkloads(records)
const mainW = workloads.find((w) => w.groups.some((g) => g.groupId === MAIN))!
const horizonW = workloads.find((w) => w.groups.some((g) => g.groupId === HORIZON))!

/** A second model against the unbounded fixture workload. Model is a candidate now, so
 * it rides on the deployment and the group_id does not change — the two models land in
 * one table. run_ids are suffixed so the merged rows stay distinct. */
function twoModelWorkload(): ReturnType<typeof loadWorkloads>[number] {
  const only = records.filter((r) => r.group_id === MAIN)
  const llama = (JSON.parse(JSON.stringify(only)) as RunRecord[]).map((r) => {
    r.deployment.model = 'meta/llama-3-8b'
    r.run_id = `llama-${r.run_id}`
    return r
  })
  return loadWorkloads([...only, ...llama])[0]!
}

/** Splits a row's HTML into its <td> cells. Cells never nest, so non-greedy works. */
function cellsOfRow(rowHtml: string): string[] {
  return rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []
}

function tbodyRows(html: string): string[] {
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)?.[1]
  if (tbody == null) throw new Error('table did not render a <tbody>')
  // Data rows now carry a run-<group_id>-<run_id> id (the reveal scroll target), so match
  // <tr with any attributes. Reproduce panels are closed under static markup, so the only
  // rows here are the data rows.
  return tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
}

function dqBand(html: string): string | undefined {
  return html.match(/<section[^>]*aria-label="Disqualified runs"[^>]*>[\s\S]*?<\/section>/)?.[0]
}

describe('SortNote (the removable active-sort chips above a table)', () => {
  it('renders nothing when the table is unsorted', () => {
    expect(renderToStaticMarkup(<SortNote sort={[]} onRemove={() => {}} />)).toBe('')
  })

  it('renders one separate chip per tier, each with its own remove button naming the column and direction', () => {
    const html = renderToStaticMarkup(
      <SortNote
        sort={[
          { key: 'e2e_p99_ms', dir: 1 },
          { key: 'tokens_per_sec', dir: -1 },
        ]}
        onRemove={() => {}}
      />,
    )
    const chips = html.match(/class="sortnote-chip"/g) ?? []
    expect(chips).toHaveLength(2)
    expect(html).toMatch(/aria-label="Remove sort by E2E p99, ascending"/)
    expect(html).toMatch(/aria-label="Remove sort by Tokens\/s, descending"/)
    expect(html).toContain('E2E p99')
    expect(html).toContain('Tokens/s')
  })

  it('numbers the tiers only when more than one column is in play', () => {
    const one = renderToStaticMarkup(
      <SortNote sort={[{ key: 'e2e_p99_ms', dir: 1 }]} onRemove={() => {}} />,
    )
    expect(one).not.toContain('sortnote-rank')
    const two = renderToStaticMarkup(
      <SortNote
        sort={[
          { key: 'e2e_p99_ms', dir: 1 },
          { key: 'tokens_per_sec', dir: -1 },
        ]}
        onRemove={() => {}}
      />,
    )
    expect((two.match(/class="sortnote-rank"/g) ?? []).length).toBe(2)
  })
})

describe('ReadoutTable, single-model workload (mainW: one model, three accelerators)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)
  const rows = tbodyRows(html)
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!

  it('renders all 10 complete runs and never the disqualified h100-tp2-len640', () => {
    expect(rows).toHaveLength(10)
    expect(tbody).not.toContain('max_model_len 640')
    expect(tbody).not.toContain('241/500')
    expect(tbody.match(/500\/500/g) ?? []).toHaveLength(10)
  })

  it('marks no automatic best: there is no ★ anywhere, and Resp/s still renders a number', () => {
    expect(html).not.toContain('★')
    for (const row of rows) {
      const cells = cellsOfRow(row)
      // deployment, gpus, ttft_p99, itl_p99, e2e_p99, e2e_mean,
      // scheduling_delay_p99, tokens_per_sec, responses_per_sec, served, preemption_count
      const respPerSec = cells[8]
      expect(respPerSec).toBeDefined()
      expect(respPerSec).toMatch(/\d/)
    }
  })

  it('renders a max_num_seqs 8 knob chip for h100-tp2-seqs8, whose TTFT p99 dwarfs stock h100-tp2 (3.47s vs 31.4ms)', () => {
    expect(html).toContain('max_num_seqs 8')
    const stockTtft = cellsOfRow(rows[1]!)[2]
    const seqs8Ttft = cellsOfRow(rows[9]!)[2]
    expect(stockTtft).toContain('31.4ms')
    expect(seqs8Ttft).toContain('3.47s')
  })

  it('renders GPUs and Served inside the derived treatment, naming their formulas', () => {
    expect(html).toMatch(/class="derived"[^>]*data-tip="tp × num_instances[^"]*"/)
    expect(html).toMatch(/class="derived"[^>]*data-tip="completed_requests ÷ injected_requests[^"]*"/)
  })

  it('keeps the group separator at the throughput/health boundary, on the Served cells', () => {
    // Served leads the health group now, so the grey bar sits to its left in both the
    // header and every body row — not only the header.
    const servedCells = tbody.match(/<td class="gsep">[\s\S]*?completed_requests ÷ injected_requests/g) ?? []
    expect(servedCells).toHaveLength(10)
    expect(html).toMatch(/<th[^>]*class="gsep"[^>]*>[\s\S]*?Served/)
  })

  it('carries a help note on the Served header, distinguishing it from the workload Requests', () => {
    const infoSpans = html.match(/class="info"[^>]*data-tip="[^"]*"/g) ?? []
    const served = infoSpans.filter((s) => s.includes('completed ÷ injected'))
    expect(served).toHaveLength(1)
    expect(served[0]).toContain('Requests')
  })

  it('has no Model column and no per-row model line: one model needs no label on every row', () => {
    expect(html).not.toMatch(/<th[^>]*scope="col"[^>]*>Model<\/th>/)
    expect(tbody).not.toContain('class="dep-model"')
  })

  it('shows the GPU type on every row, because this table spans three accelerators', () => {
    for (const row of rows) {
      const first = cellsOfRow(row)[0]!
      expect(first).toMatch(/class="dep-hw"/)
    }
    expect(tbody).toContain('A100-SXM')
    expect(tbody).toContain('L40S')
  })

  it('lists the topology fields (tp, dp, num_instances) on the key line of every row', () => {
    const first = cellsOfRow(rows[0]!)[0]!
    for (const field of ['tp', 'dp', 'num_instances']) expect(first).toContain(`<i>${field}</i>`)
  })

  it('renders max_model_len as a boxed knob chip, not on the key line', () => {
    const first = cellsOfRow(rows[0]!)[0]!
    expect(first).not.toContain('<i>max_model_len</i>')
    expect(first).toMatch(/class="knob"[^>]*>max_model_len 40960/)
  })

  it('collapses the constant remainder of the spec behind a "show all" control', () => {
    const first = cellsOfRow(rows[0]!)[0]!
    expect(first).toMatch(/class="dep-more"/)
    expect(first).toContain('Show all')
    expect(first).not.toContain('scheduler')
    // model is a prominent field with its own slot, so it never lands in the collapsed rest.
    expect(first).not.toContain('qwen/qwen3-14b')
  })
})

describe('ReadoutTable, two models against one workload', () => {
  const two = twoModelWorkload()
  const html = renderToStaticMarkup(<ReadoutTable workload={two} models={[]} />)
  const rows = tbodyRows(html)

  it('folds the model name into the Deployment cell, with no separate Model column', () => {
    expect(html).not.toMatch(/<th[^>]*>Model<\/th>/)
    expect(html).toMatch(/<th[^>]*class="lft"[^>]*>Deployment<\/th>/)
    for (const row of rows) {
      const first = cellsOfRow(row)[0]!
      expect(first).toMatch(/class="dep-model"[^>]*>(meta\/llama-3-8b|qwen\/qwen3-14b)</)
    }
  })

  it('crowns nothing: no ★ best-marker anywhere', () => {
    expect(html).not.toContain('★')
  })

  it('renders every model’s complete rows (10 per model, unsorted on load)', () => {
    expect(rows).toHaveLength(20)
    const models = rows.map((row) => (cellsOfRow(row)[0]!.match(/llama-3-8b|qwen3-14b/) ?? [])[0])
    expect(new Set(models)).toEqual(new Set(['llama-3-8b', 'qwen3-14b']))
  })

  it('shows every disqualified run, labeled by model, and keeps the would-be rank scoped to the shared work (§5.1)', () => {
    const band = dqBand(html)
    expect(band).toBeDefined()
    expect(band).toContain('requests_dropped')
    // One disqualified run per model, each labeled by model.
    expect(band).toContain('meta/llama-3-8b')
    expect(band).toContain('qwen/qwen3-14b')
    // The rank is kept: the work it never did is shared by the whole table.
    expect(band).toContain('would place it')
    expect(band).toMatch(/#\d+ of \d+/)
  })
})

describe('ReadoutTable, filtering a two-model workload to one model', () => {
  const two = twoModelWorkload()
  const html = renderToStaticMarkup(<ReadoutTable workload={two} models={['qwen/qwen3-14b']} />)

  it('shows only the selected model’s rows and drops the per-row model line (one model left)', () => {
    expect(html).not.toMatch(/<th[^>]*scope="col"[^>]*>Model<\/th>/)
    expect(tbodyRows(html)).toHaveLength(10)
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbody).not.toContain('class="dep-model"')
    expect(tbody).not.toContain('meta/llama-3-8b')
  })

  it('keeps the disqualified band with its within-table would-be rank', () => {
    const band = dqBand(html)
    expect(band).toContain('#1 of 11')
    expect(band).toContain('first place')
  })
})

describe('ReadoutTable, hardware filter (a row filter, orthogonal to the model filter)', () => {
  // mainW's comparability group spans three accelerators: H100 (5 complete + the
  // disqualified h100-tp2-len640), A100-SXM (3 complete), and L40S (2 complete).
  it('narrowed to H100 shows only the H100 rows, dropping the A100 and L40S ones', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} hardware={['H100']} />)
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbodyRows(html)).toHaveLength(5)
    expect(tbody).not.toContain('A100-SXM')
    expect(tbody).not.toContain('L40S')
  })

  it('still shows the H100 disqualified run', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} hardware={['H100']} />)
    const band = dqBand(html)
    expect(band).toContain('max_model_len 640')
  })

  it('narrowed to A100-SXM shows its 3 rows and no disqualified band (its only DQ run is H100)', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} hardware={['A100-SXM']} />,
    )
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbodyRows(html)).toHaveLength(3)
    expect(tbody).not.toContain('H100')
    expect(html).not.toMatch(/aria-label="Disqualified runs"/)
  })

  it('an empty hardware selection is unchanged: every accelerator shows (10 complete runs)', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} hardware={[]} />)
    expect(tbodyRows(html)).toHaveLength(10)
  })

  it('combines with the model filter: two models, H100 only', () => {
    const two = twoModelWorkload()
    const html = renderToStaticMarkup(<ReadoutTable workload={two} models={[]} hardware={['H100']} />)
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbody).not.toContain('A100-SXM')
    expect(tbody).not.toContain('L40S')
    // 5 complete H100 rows per model, still the model-in-cell grid.
    expect(tbodyRows(html)).toHaveLength(10)
    expect(html).not.toMatch(/<th[^>]*>Model<\/th>/)
    expect(html).toContain('class="dep-model"')
    // One accelerator now, so the cell drops the redundant GPU-type line.
    expect(html).not.toContain('class="dep-hw"')
  })
})

function sloBand(html: string): string | undefined {
  return html.match(/<details class="sloband">[\s\S]*?<\/details>/)?.[0]
}

describe('SLO-target filtering (via ReadoutTable)', () => {
  it('moves the runs that miss a target out of the ranked table and into the band', () => {
    // E2E p99 <= 5000 ms keeps only h100-tp4 and a100-tp4 of the ten complete runs.
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 5000 }} />,
    )
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbodyRows(html)).toHaveLength(2)
    expect(tbody).not.toContain('h100-tp1')
    const band = sloBand(html)
    expect(band).toBeDefined()
    expect(band).toContain('8 runs')
    expect(band).toContain('H100 tp1')
    expect(band).toContain('E2E p99')
    expect(band).toContain('exceeds')
  })

  it('renders no band and every complete row when no target is set', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} sloTargets={{}} />)
    expect(tbodyRows(html)).toHaveLength(10)
    expect(sloBand(html)).toBeUndefined()
  })

  it('replaces the table with a note when no run meets the targets, still listing them in the band', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 1 }} />,
    )
    expect(html).not.toContain('<tbody>')
    expect(html).toContain('No runs meet the SLO targets')
    const band = sloBand(html)
    expect(band).toContain('10 runs')
  })

  it('orders the section as ranked table, then SLO band, then disqualified band', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 5000 }} />,
    )
    const iTable = html.indexOf('<tbody>')
    const iSlo = html.indexOf('<details class="sloband">')
    const iDq = html.indexOf('aria-label="Disqualified runs"')
    expect(iTable).toBeGreaterThan(-1)
    expect(iSlo).toBeGreaterThan(iTable)
    expect(iDq).toBeGreaterThan(iSlo)
  })

  it('never applies SLO targets to the disqualified band', () => {
    // The impossible target empties the ranked table, but the disqualified run is unchanged.
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 1 }} />,
    )
    const band = dqBand(html)
    expect(band).toContain('max_model_len 640')
    expect(band).toContain('requests_dropped')
  })
})

describe('DqBand (via ReadoutTable)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
  const band = dqBand(html)

  it('shows h100-tp2-len640 with its requests_dropped reason and incomplete class, and never in the table body above it', () => {
    expect(band).toBeDefined()
    expect(band).toContain('H100 tp2')
    expect(band).toContain('max_model_len 640')
    expect(band).toContain('requests_dropped')
    expect(band).toContain('259 of 500')
    expect(band).toMatch(/class="chip crit"/)
    expect(band).toContain('incomplete')
    expect(tbody).not.toContain('max_model_len 640')
    expect(tbody).not.toContain('241')
  })

  it('does not label the model when the table holds only one', () => {
    // mainW is a single model, so the band's cards carry no model chip.
    expect(band).not.toContain('class="model"')
  })

  it('states it would place #1 of 11 on latency', () => {
    expect(band).toContain('#1 of 11')
    expect(band).toContain('first place')
  })

  it('renders the output-tokens-per-request figure and its comparison against the complete runs', () => {
    expect(band).toContain('output tokens per served request')
    expect(band).toContain('94.6')
    expect(band).toContain('186.1')
    expect(band).toContain('across the complete runs')
  })

  it("shows the second workload's lone record with both of its disqualification reasons", () => {
    const horizonHtml = renderToStaticMarkup(<ReadoutTable workload={horizonW} models={[]} />)
    const horizonBand = dqBand(horizonHtml)
    expect(horizonBand).toBeDefined()
    expect(horizonBand).toContain('H100 tp4')
    expect(horizonBand).toContain('window_ended_busy')
    expect(horizonBand).toContain('injection_short')
    expect(horizonBand).toContain('#1 of 1')
    expect(horizonBand).not.toContain('across the complete runs')
  })
})

describe('Reproduce the blis command (row-level)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
  const tableToggles = tbody.match(/class="reprotoggle"/g) ?? []

  it('offers a reproduce toggle on every complete row, collapsed on load', () => {
    expect(tableToggles).toHaveLength(10)
    expect(tbody).toMatch(/class="reprotoggle"[^>]*aria-expanded="false"/)
    expect(tbody).not.toContain('aria-expanded="true"')
  })

  it('does not render any blis command until a row is expanded', () => {
    expect(tbody).not.toContain('cd ../inference-sim')
    expect(tbody).not.toContain('./blis run')
  })

  it('names the run in the toggle so the control is not a bare caret to a screen reader', () => {
    expect(html).toMatch(/class="reprotoggle"[^>]*aria-label="[^"]*h100-tp1[^"]*"/)
  })

  it('offers the same reproduce toggle on a disqualified run in the band', () => {
    const band = dqBand(html)
    expect(band).toBeDefined()
    expect(band).toContain('reprotoggle')
    expect(band).toMatch(/class="reprotoggle[^"]*"[^>]*aria-label="[^"]*h100-tp2-len640[^"]*"/)
  })
})

describe('Expand all / Collapse all (bulk reproduce toggle over the table rows)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)

  it('offers both controls above a multi-row table', () => {
    expect(html).toContain('Expand all')
    expect(html).toContain('Collapse all')
    expect(html).toMatch(/aria-label="Expand every row to show its blis command"/)
    expect(html).toMatch(/aria-label="Collapse every row to hide its blis command"/)
  })

  it('rests with Collapse all disabled and Expand all enabled, since nothing is open on load', () => {
    const expand = html.match(/<button[^>]*aria-label="Expand every row[^"]*"[^>]*>/)![0]
    const collapse = html.match(/<button[^>]*aria-label="Collapse every row[^"]*"[^>]*>/)![0]
    expect(expand).not.toContain('disabled')
    expect(collapse).toContain('disabled')
  })

  it('offers the same controls with two models', () => {
    const merged = renderToStaticMarkup(<ReadoutTable workload={twoModelWorkload()} models={[]} />)
    expect(merged).toContain('Expand all')
    expect(merged).toContain('Collapse all')
  })

  it('still offers the controls for a workload with no complete rows, both disabled', () => {
    const barren = renderToStaticMarkup(<ReadoutTable workload={horizonW} models={[]} />)
    expect(barren).toContain('Expand all')
    expect(barren).toContain('Collapse all')
    const expand = barren.match(/<button[^>]*aria-label="Expand every row[^"]*"[^>]*>/)![0]
    const collapse = barren.match(/<button[^>]*aria-label="Collapse every row[^"]*"[^>]*>/)![0]
    expect(expand).toContain('disabled')
    expect(collapse).toContain('disabled')
  })
})

describe('ReproPanel (what an opened row reveals)', () => {
  const record = mainW.groups[0]!.complete[0]!
  const html = renderToStaticMarkup(<ReproPanel record={record} />)

  it('shows the blis invocation verbatim from the run, and where to run it — but no baked-in cd', () => {
    expect(html).toContain('./blis run')
    for (const token of record.provenance.argv) expect(html).toContain(token)
    expect(html).toContain(record.provenance.cwd)
    expect(html).not.toContain('cd ')
  })

  it('explains determinism and the temp metrics path, so the verbatim command is not misread', () => {
    expect(html).toContain('deterministic')
    expect(html).toContain(String(record.group.seed))
    expect(html).toContain('--metrics-path')
    expect(html).toContain(record.provenance.blis_commit)
  })
})

describe('WorkloadHeader', () => {
  const html = renderToStaticMarkup(<WorkloadHeader workload={mainW} />)

  it('titles the section by the work offered, without a model clause', () => {
    expect(html).toContain('500 requests at 6.0 req/s')
    expect(html).not.toContain(' on qwen/qwen3-14b')
  })

  it('describes the work alone, without listing the models run against it', () => {
    expect(html).not.toContain('qwen/qwen3-14b')
  })

  it('renders the request count and the offered rate', () => {
    expect(html).toContain(String(mainW.groups[0]!.group.workload.num_requests))
    expect(html).toContain('6.0')
  })

  it('renders the arrival process inside the derived treatment, since blis does not report it', () => {
    expect(html).toContain('arrival process is not reported by blis')
    expect(html).toContain(mainW.groups[0]!.group.workload.arrival_process)
  })
})

// A spec-backed workload (a preset or saved profile): the flat fields are placeholder
// zeros, the real load lives in the spec, and the run carries the catalog name. The spec
// is a single gaussian client, like the chatbot preset, so the flat grid can describe it.
function specWorkload(): ReturnType<typeof loadWorkloads>[number] {
  const base = JSON.parse(JSON.stringify(records.find((r) => r.group_id === MAIN)!)) as RunRecord
  base.group_id = 'specgroup01'
  base.workload_name = 'chatbot'
  base.group.workload = {
    type: 'workload-spec',
    arrival_process: 'constant',
    num_requests: 0,
    load: { kind: 'rate', value: 0 },
    prompt_tokens: 0,
    prompt_tokens_stdev: 0,
    output_tokens: 0,
    output_tokens_stdev: 0,
    spec_file: null,
    spec_sha256: 'abc',
    spec: {
      version: '2',
      aggregate_rate: 10,
      num_requests: 500,
      clients: [
        {
          id: 'c0',
          rate_fraction: 1,
          arrival: { process: 'constant' },
          input_distribution: { type: 'gaussian', params: { mean: 256, std_dev: 100, min: 2, max: 800 } },
          output_distribution: { type: 'gaussian', params: { mean: 256, std_dev: 100, min: 1, max: 1024 } },
        },
      ],
    },
  } as RunRecord['group']['workload']
  return loadWorkloads([base])[0]!
}

describe('WorkloadHeader, a spec-backed workload', () => {
  const html = renderToStaticMarkup(<WorkloadHeader workload={specWorkload()} />)

  it('titles the section by the catalog name, not a shape of zeros', () => {
    expect(html).toContain('chatbot')
    expect(html).not.toContain('0 requests at 0.0 req/s')
  })

  it('does not repeat the tags: the workload picker card already carries them', () => {
    expect(html).not.toContain('spec-tag')
  })

  it('shows no redundant caption: the detail grid already states the shape', () => {
    expect(html).not.toContain('spec-sub')
    expect(html).not.toContain('spec-backed workload')
    expect(html).not.toContain('256 ±100 in / 256 ±100 out tokens')
  })

  it('fills the grid from the single client, like a distribution: arrival, rate, token shapes', () => {
    expect(html).toContain('Arrival')
    expect(html).toContain('Requests')
    expect(html).toContain('Offered rate')
    expect(html).toContain('Prompt tokens')
    expect(html).toContain('Output tokens')
    expect(html).toContain('256 ±100')
    expect(html).toContain('[2–800]') // the gaussian clamp, as small print
  })

  it('offers the full workload spec on demand', () => {
    expect(html).toContain('Full workload spec')
    expect(html).toContain('aggregate_rate: 10')
  })
})

describe('NewRun', () => {
  // NewRun takes the flat comparability groups (for target detection and the flags basis)
  // and fetches the workload catalog itself. The catalog fetch is a mount effect, which
  // does not run under renderToStaticMarkup, so this is the offline shape: the selector
  // falls back to the custom card.
  const groups = workloads.flatMap((w) => w.groups)
  // NewRun is a controlled form now: App owns the values and the run state, so the test
  // supplies them. This is the offline, untouched-form shape (initialValues, no run in
  // flight, no error), the same starting point the old internal state produced.
  const html = renderToStaticMarkup(
    <NewRun
      groups={groups}
      values={initialValues()}
      onChange={() => {}}
      workloadInitialized={false}
      onWorkloadInitialized={() => {}}
      runIdEdited={false}
      onRunIdEdited={() => {}}
      customNameEdited={false}
      onCustomNameEdited={() => {}}
      running={false}
      errorMessage={null}
      onRun={() => {}}
    />,
  )

  it('splits the form the way the schema splits, work above candidate', () => {
    expect(html).toContain('Work offered')
    expect(html).toContain('Candidate under test')
  })

  it('leads the work with a workload-type toggle: a saved/preset workload or a custom distribution', () => {
    expect(html).toContain('Workload type')
    expect(html).toContain('Saved / preset')
    expect(html).toContain('Custom (distribution)')
    // The custom option is now a toggle, not an entry in the workload dropdown.
    expect(html).not.toContain('Custom (define below)')
  })

  it('puts the model on the candidate side, in the Model & sharding group (E1)', () => {
    expect(html).toContain('Model &amp; sharding')
    expect(html).toContain('qwen/qwen3-14b')
  })

  it('offers the canonical accelerators, not the A100-80 alias of A100-SXM', () => {
    for (const name of ['H100', 'A100-SXM', 'L40S']) expect(html).toContain(name)
    // A100-80 is the same accelerator as A100-SXM upstream, so it is not a second button;
    // it survives only as aliasesOf() metadata for the duplicate-row guard.
    expect(html).not.toContain('A100-80')
    expect(html).not.toContain('= A100-SXM')
  })

  it('opens with a descriptive run id already in the field, not a blank one to fill', () => {
    // The candidate names its own run (<hardware>-tp<tp>) so the page is runnable without
    // typing a filename; the empty-id prompt is gone. The mount effect then dedupes the id
    // against the board, but it cannot run under renderToStaticMarkup, so this only pins
    // the seeded starting value.
    expect(html).toContain('value="h100-tp1"')
    expect(html).not.toContain('A run needs an id')
  })

  it('falls back to the editable custom card, tokens and deadline included', () => {
    expect(html).toContain('Input mean')
    expect(html).toContain('Input max')
    expect(html).toContain('Output mean')
    expect(html).toContain('Output max')
    expect(html).toContain('Deadline (s, negative disables)')
    expect(html).toContain('author a workload in the Workloads tab')
  })

  it('names the custom workload so it can be saved to the catalog on Run', () => {
    // A custom (distribution) workload is persisted to the catalog when run, so it carries a
    // Name field, and the card says as much.
    expect(html).toContain('Name')
    expect(html).toContain('placeholder="my-workload"')
    expect(html).toContain('Saved to the catalog under this name when you run it')
  })

  it('opens the custom name with a suggested unique value, not a blank field', () => {
    // The name is prefilled the way the run id is, so the card is runnable without typing
    // one. The mount effect then dedupes it against the catalog, but effects do not run
    // under renderToStaticMarkup, so this pins the seeded starting value.
    expect(html).toContain('value="custom-1"')
  })

  it('exposes the candidate serving knobs directly, grouped by theme', () => {
    for (const label of [
      'Data parallel',
      'Instances',
      'Max model length',
      'KV block size (tokens)',
      'Max sequences',
      'Max batched tokens',
      'Long-prefill token threshold',
      'GPU memory utilization',
      'Scheduler',
      'Preemption policy',
      'Routing policy',
      'Admission policy',
      'KV cache dtype',
      'Draft tokens',
      'Acceptance rate',
    ]) {
      expect(html, label).toContain(label)
    }
    expect(html).not.toContain('Other flags from')
  })

  it('keeps the off/default-heavy speculative group collapsed into <details> (§6.2)', () => {
    expect(html).toMatch(/<details[^>]*class="nrflaggroup"[^>]*>\s*<summary[^>]*>Speculative decoding/)
  })

  it('groups admission and routing under one collapsed section, admission first', () => {
    // One section header covers both, since admission (accept/queue) and routing (which
    // instance) are the same request-flow decision. It folds into a <details> like every
    // group, and starts closed: it is a rarely-touched corner of the candidate.
    expect(html).toMatch(
      /<details class="nrflaggroup">\s*<summary[^>]*>Admission &amp; routing/,
    )
    expect(html).not.toContain('Admission &amp; flow control')
    // Admission policy is the request lifecycle's first step, so it reads before routing.
    const iAdmission = html.indexOf('>Admission policy<')
    const iRouting = html.indexOf('>Routing policy<')
    expect(iAdmission).toBeGreaterThan(-1)
    expect(iRouting).toBeGreaterThan(-1)
    expect(iAdmission).toBeLessThan(iRouting)
  })

  it('folds every group into a <details>, opening the ones a run usually touches (§6.2)', () => {
    // The always-shown groups are gone: each is now a <details> a reader can collapse. The
    // groups a run usually touches seed open; the off/default-heavy ones (admission, the two
    // below) seed closed.
    expect(html).toMatch(/<details class="nrflaggroup" open="">\s*<summary[^>]*>Model &amp; sharding/)
    expect(html).toMatch(/<details class="nrflaggroup" open="">\s*<summary[^>]*>Scheduling &amp; batching/)
    expect(html).toMatch(/<details class="nrflaggroup" open="">\s*<summary[^>]*>KV cache/)
    expect(html).toMatch(/<details class="nrflaggroup" open="">\s*<summary[^>]*>Cluster/)
    // No group renders as the old always-open heading anymore.
    expect(html).not.toContain('nrgrouphead')
  })

  it('offers the routing policy as a segmented control, not a dropdown', () => {
    // The four policies are radio options in a labelled radiogroup, all visible at once.
    expect(html).toMatch(/role="radiogroup" aria-labelledby="routing-label"/)
    for (const policy of ['round-robin', 'least-loaded', 'weighted', 'always-busiest']) {
      expect(html).toMatch(new RegExp(`name="routingPolicy"[^>]*value="${policy}"`))
    }
    // Round-robin is the default, so the scorer sub-panel is not shown until weighted.
    expect(html).not.toContain('Scorers &amp; weights')
  })

  it('sets the latency model apart in its own Simulation model fieldset, after the candidate', () => {
    // The latency model is a blis simulator setting, not a deployment property under test, so
    // it is lifted out of the candidate box into its own section rather than sitting among the
    // serving knobs. The note says so in as many words.
    expect(html).toContain('Simulation model')
    expect(html).toContain('a deployment property')
    // Its own fieldset (neutral tint), placed after Candidate under test so the primary
    // Work -> Candidate reading order is untouched.
    const iCand = html.indexOf('Candidate under test')
    const iSim = html.indexOf('<fieldset class="nrsim">')
    expect(iCand).toBeGreaterThan(-1)
    expect(iSim).toBeGreaterThan(iCand)
    // The Latency model control lives in that section, not among the candidate serving knobs.
    expect(html.slice(iSim)).toContain('Latency model')
  })

  it('offers prefill/decode disaggregation as its own collapsed group', () => {
    expect(html).toMatch(/<details[^>]*class="nrflaggroup"[^>]*>\s*<summary[^>]*>Prefill\/decode split/)
  })

  it('gates the MoE knobs on model class: a dense default model disables them, keeping the note', () => {
    // The default model, qwen/qwen3-14b, is dense. The expert-parallel toggle and MoE comm
    // backend stay in the form so the candidate box keeps a stable shape, but disabled, and a
    // note explains why rather than letting the reader set a knob blis would reject.
    expect(html).toContain('apply to MoE models only')
    expect(html).toContain('id="ep-label"')
    // The EP radiogroup is disabled (its own class), as is the comm-backend select trigger.
    expect(html).toContain('class="seg disabled"')
    expect(html).toMatch(
      /id="moeCommBackend-label">MoE comm backend<\/span><div class="sel"><button type="button" class="sel-trigger" disabled=""/,
    )
  })
})

describe('the per-run delete control (a trash button, server mode only)', () => {
  it('renders no trash button by default, so the static board offers no delete', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)
    expect(html).not.toContain('class="delrow')
    expect(html).not.toContain('Delete the run')
  })

  it('renders a trash button per complete row when deletion is offered', () => {
    const seen: RunRecord[] = []
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} canDelete onDelete={(r) => seen.push(r)} />,
    )
    const buttons = html.match(/class="delrow onrow"/g) ?? []
    expect(buttons.length).toBe(tbodyRows(html).length)
    expect(buttons.length).toBeGreaterThan(0)
    // Each names its run in the accessible label so the control is unambiguous.
    expect(html).toMatch(/aria-label="Delete the run [^"]+"/)
  })

  it('offers deletion on disqualified runs too, in their band', () => {
    const withDelete = renderToStaticMarkup(
      <ReadoutTable workload={horizonW} models={[]} canDelete onDelete={() => {}} />,
    )
    const band = dqBand(withDelete)!
    expect(band).toContain('class="delrow dq"')

    // and not when deletion is not offered
    const without = renderToStaticMarkup(<ReadoutTable workload={horizonW} models={[]} />)
    expect(dqBand(without)!).not.toContain('class="delrow')
  })
})
