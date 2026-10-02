import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadWorkloads } from './load'
import type { RunRecord } from './load'
import { ReadoutTable } from './components/ReadoutTable'
import { DqWhy } from './components/DqWhy'
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

const MAIN = '86575212efc8' // the unbounded qwen/qwen3-14b workload, 11 records
const HORIZON = 'e5538d4d5107' // the bounded-window lone disqualified run

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

/** The unbounded fixture workload swept across a second offered load (rate 10 added to the
 *  existing rate 6). One profile, two comparability groups. */
function twoLoadWorkload(): ReturnType<typeof loadWorkloads>[number] {
  const at6 = records.filter((r) => r.group_id === MAIN)
  const at10 = (JSON.parse(JSON.stringify(at6)) as RunRecord[]).map((r) => {
    // Offered load is the spec's aggregate_rate now, not the flat load placeholder.
    ;(r.group.workload.spec as Record<string, unknown>).aggregate_rate = 10
    r.group_id = `l10-${r.group_id}`
    r.run_id = `l10-${r.run_id}`
    return r
  })
  return loadWorkloads([...at6, ...at10])[0]!
}

/** Splits a row's HTML into its <td> cells. Cells never nest, so non-greedy works. */
function cellsOfRow(rowHtml: string): string[] {
  return rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []
}

/** A <tr>'s opening tag alone, for classifying it by id/class. */
function openTag(tr: string): string {
  return tr.slice(0, tr.indexOf('>') + 1)
}

/** Every <tr> in the tbody, in document order: the data rows, the windowed divider, and the
 *  windowed rows. Reproduce panels are closed under static markup, so nothing else appears. */
function allTbodyRows(html: string): string[] {
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)?.[1]
  if (tbody == null) throw new Error('table did not render a <tbody>')
  return tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
}

/** The ranked complete rows: data rows (id="run-…") that are not the windowed (.dqline) rows.
 *  Disqualified runs now render inline beneath the ranked rows, so this excludes them. */
function tbodyRows(html: string): string[] {
  return allTbodyRows(html).filter((tr) => /id="run-/.test(openTag(tr)) && !/dqline/.test(openTag(tr)))
}

/** The disqualified rows, shown inline beneath the ranked rows (muted, flagged .dqline). */
function dqRows(html: string): string[] {
  return allTbodyRows(html).filter((tr) => /dqline/.test(openTag(tr)))
}

/** The divider row that opens the windowed group, or undefined when there are none. */
function dqDivider(html: string): string | undefined {
  return allTbodyRows(html).find((tr) => /dqsub/.test(openTag(tr)))
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

  it('renders the 10 complete runs, with the disqualified h100-tp2-len640 as a flagged row below them', () => {
    expect(rows).toHaveLength(10)
    // The complete rows all served the full 500; none is the shed run.
    expect(rows.join('').match(/500\/500/g) ?? []).toHaveLength(10)
    for (const row of rows) expect(row).not.toContain('max_model_len 640')
    // The disqualified run is shown, not hidden: one flagged row beneath the ranked ones.
    const dq = dqRows(html)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('dqflag')
    expect(dq[0]).toContain('max_model_len 640')
    expect(dq[0]).toContain('241') // its served subset shows in the Served cell
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

  it('tags the candidate-identity block so it freezes on horizontal scroll', () => {
    // The grouped candidate cell and the GPUs column carry the classes that pin them at the left
    // edge (see .gcol-candidate / .gpcol in styles.css), so the whole candidate block — grouped
    // header included — stays frozen as the reader scrolls right into the metrics.
    expect(html).toMatch(/scope="colgroup" class="gcol-candidate"/)
    expect(html).toMatch(/<td class="gpcol">/)
  })

  it('keeps the group separator at the throughput/health boundary, on the Served cells', () => {
    // Served leads the health group now, so the grey bar sits to its left in both the
    // header and every body row — not only the header.
    // Every body row carries the separator on its Served cell — the 10 complete rows and the
    // 1 windowed row alike, since the windowed run is a full table row now.
    const servedCells = tbody.match(/<td class="gsep">[\s\S]*?completed_requests ÷ injected_requests/g) ?? []
    expect(servedCells).toHaveLength(11)
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

describe('ReadoutTable, KV cache metrics are always shown', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)

  it('offers no KV cache toggle: the columns are always on', () => {
    expect(html).not.toContain('KV cache metrics')
  })

  it('renders all four KV columns, so the group is part of the readout', () => {
    for (const label of ['Cache hit', 'Preempt rate', 'KV alloc fails', 'KV thrash'])
      expect(html).toContain(label)
    // The uppercased "KV" group header is the colgroup cell text (raw key "kv").
    expect(html).toMatch(/scope="colgroup"[^>]*>kv</)
  })

  it('wraps the table in a scroll frame so a wide readout scrolls in place, not off-screen', () => {
    expect(html).toMatch(/class="tscroll"/)
  })

  it('renders the four KV cells in every body row', () => {
    // Each data row renders deployment + 10 base numeric columns + 4 KV = 15 cells.
    // (A sweep would add a Load cell; mainW is a single load.)
    for (const row of tbodyRows(html)) {
      expect(cellsOfRow(row)).toHaveLength(15)
    }
  })
})

describe('ReadoutTable, a load sweep (one profile, two offered loads)', () => {
  const w = twoLoadWorkload()
  const html = renderToStaticMarkup(<ReadoutTable workload={w} models={[]} />)

  it('shows a load column named for the kind (rate here), before Deployment, and sortable', () => {
    expect(html).toContain('>Arrival rate<')
    expect(html.indexOf('>Arrival rate<')).toBeLessThan(html.indexOf('Deployment'))
    // The column is a sort button keyed on load, like every metric column.
    expect(html).toMatch(/<button[^>]*class="sortbtn"[^>]*aria-label="Sort by Arrival rate"/)
  })

  it('renders each row at its offered load level', () => {
    expect(html).toContain('6.0')
    expect(html).toContain('10.0')
  })

  it('omits the load column when the reader narrows to a single load level', () => {
    const one = renderToStaticMarkup(<ReadoutTable workload={w} models={[]} loads={[6]} />)
    expect(one).not.toContain('>Arrival rate<')
  })

  it('marks the table hasload and tags the Load column so it can freeze beside Deployment', () => {
    // hasload drives the stacked-sticky freeze and the gray separator (styles.css); the Load
    // header and every load cell carry .lcol, the class that pins the column at the left edge.
    expect(html).toMatch(/<table class="readout hasload">/)
    expect(html).not.toContain('noloadfreeze')
    // The Load header cell and the body load cells both carry lcol.
    expect(html).toMatch(/<th[^>]*class="lcol"/)
    expect(html).toMatch(/<td class="loadcell lcol">/)
  })
})

describe('ReadoutTable, a trace session-pool sweep', () => {
  function traceRec(sessions: number): RunRecord {
    const r = JSON.parse(
      JSON.stringify(records.find((x) => x.group_id === MAIN && x.status.complete)!),
    ) as RunRecord
    r.group_id = `wk-${sessions}`
    r.run_id = 'weka'
    r.workload_name = 'weka-jsonl'
    r.group.workload = {
      type: 'trace',
      arrival_process: 'constant',
      num_requests: 0,
      load: { kind: 'sessions', value: sessions },
      prompt_tokens: 0,
      prompt_tokens_stdev: 0,
      output_tokens: 0,
      output_tokens_stdev: 0,
      spec_file: null,
      spec_sha256: null,
      trace: {
        sha256: 'weka-abc',
        session_mode: 'closed-loop',
        concurrent_sessions: sessions,
        total_sessions: 183,
        shuffle_corpus: true,
        think_time_ms: 30,
        think_time_dist: '',
        source_format: 'weka',
        records: 26648,
        sessions: 183,
        session_context_growth: 'accumulate',
      },
    } as RunRecord['group']['workload']
    return r
  }
  const w = loadWorkloads([traceRec(8), traceRec(32)])[0]!
  const html = renderToStaticMarkup(<ReadoutTable workload={w} models={[]} />)

  it('names the load column "Concurrent sessions" for a sessions sweep', () => {
    expect(html).toContain('>Concurrent sessions<')
    expect(html).toMatch(/aria-label="Sort by Concurrent sessions"/)
  })

  it('shows the two session-pool levels as the load column, before Deployment', () => {
    expect(html).toMatch(/<td class="loadcell lcol">/)
    expect(html.indexOf('>Concurrent sessions<')).toBeLessThan(html.indexOf('Deployment'))
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

  it('shows every disqualified run as a flagged row, one per model, labeled by model', () => {
    const dq = dqRows(html)
    expect(dq).toHaveLength(2)
    for (const r of dq) expect(r).toContain('dqflag')
    const models = dq.map((r) => (r.match(/meta\/llama-3-8b|qwen\/qwen3-14b/) ?? [])[0])
    expect(new Set(models)).toEqual(new Set(['meta/llama-3-8b', 'qwen/qwen3-14b']))
    // The divider names the count.
    expect(dqDivider(html)).toContain('2 runs')
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

  it('keeps the disqualified run as a flagged row when filtered to one model', () => {
    const dq = dqRows(html)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('dqflag')
    expect(dq[0]).toContain('max_model_len 640')
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

  it('still shows the H100 disqualified run as a flagged row', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} hardware={['H100']} />)
    const dq = dqRows(html)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('max_model_len 640')
  })

  it('narrowed to A100-SXM shows its 3 rows and no windowed group (its only DQ run is H100)', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} hardware={['A100-SXM']} />,
    )
    const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
    expect(tbodyRows(html)).toHaveLength(3)
    expect(tbody).not.toContain('H100')
    expect(dqRows(html)).toHaveLength(0)
    expect(dqDivider(html)).toBeUndefined()
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

  it('replaces the table with a note when no complete run meets the targets and there are no windowed rows', () => {
    // A100-SXM has 3 complete runs and no disqualified run, so an impossible target leaves the
    // table with nothing to show and the note stands in for it.
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} hardware={['A100-SXM']} sloTargets={{ e2e_p99_ms: 1 }} />,
    )
    expect(html).not.toContain('<tbody>')
    expect(html).toContain('No runs meet the SLO targets')
    const band = sloBand(html)
    expect(band).toContain('3 runs')
  })

  it('still shows the windowed rows when an SLO target hides every complete run', () => {
    // The target hides all 10 complete runs into the SLO band, but the disqualified run is not
    // subject to SLO, so the table renders it rather than falling back to the note.
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 1 }} />,
    )
    expect(html).toContain('<tbody>')
    expect(html).not.toContain('No runs meet the SLO targets')
    expect(tbodyRows(html)).toHaveLength(0)
    expect(dqRows(html)).toHaveLength(1)
    expect(sloBand(html)).toContain('10 runs')
  })

  it('orders the rows ranked-then-windowed, with the SLO band below the whole table', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 5000 }} />,
    )
    const iTbody = html.indexOf('<tbody>')
    const iDivider = html.indexOf('class="dqsub"')
    const iSlo = html.indexOf('<details class="sloband">')
    expect(iTbody).toBeGreaterThan(-1)
    expect(iDivider).toBeGreaterThan(iTbody) // the windowed divider sits inside the tbody, after the ranked rows
    expect(iSlo).toBeGreaterThan(iDivider) // the SLO band follows the whole table
  })

  it('never applies SLO targets to the windowed rows', () => {
    // The impossible target empties the ranked table, but the disqualified run is unchanged.
    const html = renderToStaticMarkup(
      <ReadoutTable workload={mainW} models={[]} sloTargets={{ e2e_p99_ms: 1 }} />,
    )
    const dq = dqRows(html)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('max_model_len 640')
  })
})

describe('Disqualified rows, inline (via ReadoutTable)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)

  it('shows h100-tp2-len640 as a flagged row beneath the ranked rows, not among them', () => {
    const dq = dqRows(html)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('dqflag')
    expect(dq[0]).toContain('max_model_len 640')
    expect(dq[0]).toContain('241') // its served subset shows in the row's Served cell
    // It is none of the ranked complete rows above the divider.
    for (const r of tbodyRows(html)) expect(r).not.toContain('max_model_len 640')
  })

  it('introduces the group with a windowed divider naming the count', () => {
    const div = dqDivider(html)
    expect(div).toBeDefined()
    expect(div).toContain('Windowed')
    expect(div).toContain('1 run')
  })

  it('orders the windowed row after every ranked complete row', () => {
    const rows = allTbodyRows(html)
    const isComplete = (tr: string) => /id="run-/.test(openTag(tr)) && !/dqline/.test(openTag(tr))
    const iLastComplete = rows.map(isComplete).lastIndexOf(true)
    const iDivider = rows.findIndex((tr) => /dqsub/.test(openTag(tr)))
    const iFirstDq = rows.findIndex((tr) => /dqline/.test(openTag(tr)))
    expect(iDivider).toBeGreaterThan(iLastComplete)
    expect(iFirstDq).toBeGreaterThan(iDivider)
  })

  it('does not label the model when the table holds only one', () => {
    // mainW is a single model, so the flagged row carries no model line.
    expect(dqRows(html)[0]).not.toContain('class="dep-model"')
  })

  it('shows the lone windowed record of a bounded-window workload as a flagged row', () => {
    const horizonHtml = renderToStaticMarkup(<ReadoutTable workload={horizonW} models={[]} />)
    const dq = dqRows(horizonHtml)
    expect(dq).toHaveLength(1)
    expect(dq[0]).toContain('dqflag')
    expect(dqDivider(horizonHtml)).toContain('1 run')
  })
})

describe('DqWhy (the why-block in an expanded disqualified row)', () => {
  const dqRec = records.find((r) => r.group_id === MAIN && !r.status.complete)!
  const horizonRec = records.find((r) => r.group_id === HORIZON)!

  it('lists every disqualification reason with its class and detail', () => {
    const html = renderToStaticMarkup(<DqWhy record={dqRec} completePerReqMean={186.1} />)
    expect(html).toContain('requests_dropped')
    expect(html).toMatch(/class="chip crit"/)
    expect(html).toContain('incomplete')
    expect(html).toContain('259 of 500')
  })

  it('quantifies the size bias against the complete runs', () => {
    const html = renderToStaticMarkup(<DqWhy record={dqRec} completePerReqMean={186.1} />)
    expect(html).toContain('output tokens per served request')
    expect(html).toContain('94.6')
    expect(html).toContain('186.1')
    expect(html).toContain('across the complete runs')
  })

  it('makes no ranking claim (windowed rows are never ranked beside complete ones)', () => {
    const html = renderToStaticMarkup(<DqWhy record={dqRec} completePerReqMean={186.1} />)
    expect(html).not.toContain('would place')
    expect(html).not.toContain('of 11')
  })

  it('reports both reasons and omits the comparison when there is no complete baseline', () => {
    const html = renderToStaticMarkup(<DqWhy record={horizonRec} completePerReqMean={null} />)
    expect(html).toContain('window_ended_busy')
    expect(html).toContain('injection_short')
    expect(html).not.toContain('across the complete runs')
  })
})

describe('Reproduce the blis command (row-level)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)
  const tbody = html.match(/<tbody>([\s\S]*)<\/tbody>/)![1]!
  const tableToggles = tbody.match(/class="reprotoggle"/g) ?? []

  it('offers a reproduce toggle on every row (complete and windowed), collapsed on load', () => {
    // A toggle on each of the 10 complete rows and the 1 windowed row.
    expect(tableToggles).toHaveLength(tbodyRows(html).length + dqRows(html).length)
    expect(tableToggles).toHaveLength(11)
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

  it('offers the same reproduce toggle on a disqualified row', () => {
    const dq = dqRows(html)[0]!
    expect(dq).toContain('reprotoggle')
    expect(dq).toMatch(/class="reprotoggle"[^>]*aria-label="[^"]*h100-tp2-len640[^"]*"/)
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
    // A single-load workload keeps its offered load in the title; only a sweep drops it. The
    // model is never named — it is a per-row candidate.
    expect(html).toContain('<h2>500 requests at 6.0 req/s</h2>')
    expect(html).not.toContain(' on qwen/qwen3-14b')
  })

  it('does not repeat the offered rate as a field: the Load filter carries it, the title keeps it', () => {
    // The rate moved to the always-on Load filter, so the card no longer has an "Offered rate"
    // row; the single-load title still names the rate.
    expect(html).not.toContain('Offered rate')
    expect(html).toContain('<h2>500 requests at 6.0 req/s</h2>')
  })

  it('does not list the load levels as a field for a sweep (the Load filter lists them)', () => {
    const sweepHtml = renderToStaticMarkup(<WorkloadHeader workload={twoLoadWorkload()} />)
    expect(sweepHtml).not.toContain('Load levels')
    expect(sweepHtml).not.toContain('Offered rate')
  })

  it('describes the work alone, without listing the models run against it', () => {
    expect(html).not.toContain('qwen/qwen3-14b')
  })

  it('renders the request count and the offered rate', () => {
    expect(html).toContain(String(mainW.groups[0]!.group.workload.num_requests))
    expect(html).toContain('6.0')
  })

  it('names the arrival process, read from the spec', () => {
    // The main workload is a one-client spec now; its arrival is authored in the spec
    // (constant), shown in the grid rather than derived.
    expect(html).toContain('Arrival')
    expect(html).toContain('constant')
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

  it('fills the grid from the single client, like a distribution: arrival, requests, token shapes', () => {
    expect(html).toContain('Arrival')
    expect(html).toContain('Requests')
    // The offered load is no longer a field here; the Load filter carries it.
    expect(html).not.toContain('Offered rate')
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

  it('feeds the accelerator picker from the server, seeding it with the current value', () => {
    // The picker is now fed by GET /api/hardware (a mount effect), like the model select,
    // rather than a baked-in list. Effects do not run under renderToStaticMarkup, so this
    // offline shape shows only the seeded current value; the rest of the catalogue (L40S,
    // A100-SXM, ...) arrives once the server answers.
    expect(html).toContain('Accelerator')
    expect(html).toContain('H100')
    expect(html).not.toContain('L40S')
    // The A100-80 alias is never offered as its own button — it is folded into A100-SXM.
    expect(html).not.toContain('A100-80')
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
    // A trash button on every row, complete and windowed alike.
    expect(buttons.length).toBe(tbodyRows(html).length + dqRows(html).length)
    expect(buttons.length).toBeGreaterThan(0)
    // Each names its run in the accessible label so the control is unambiguous.
    expect(html).toMatch(/aria-label="Delete the run [^"]+"/)
  })

  it('offers deletion on a disqualified row too', () => {
    const withDelete = renderToStaticMarkup(
      <ReadoutTable workload={horizonW} models={[]} canDelete onDelete={() => {}} />,
    )
    expect(dqRows(withDelete)[0]).toContain('class="delrow onrow"')

    // and not when deletion is not offered
    const without = renderToStaticMarkup(<ReadoutTable workload={horizonW} models={[]} />)
    expect(dqRows(without)[0]).not.toContain('delrow')
  })
})
