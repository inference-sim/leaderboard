import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewRun } from './components/NewRun'
import { initialValues } from './newrun'
import { expandSweep, initSweepRun, runPool, countsOf, toggleAxisValue } from './sweep'

const base = initialValues()

// Every NewRun prop the integration render needs; the two tests override mode/values/axes.
const common = {
  groups: [],
  values: base,
  onChange: () => {},
  workloadInitialized: true,
  onWorkloadInitialized: () => {},
  runIdEdited: false,
  onRunIdEdited: () => {},
  customNameEdited: false,
  onCustomNameEdited: () => {},
  running: false,
  errorMessage: null,
  onRun: () => {},
  onModeChange: () => {},
  sweepAxes: {},
  onSweepAxesChange: () => {},
  loadValues: [],
  onLoadValuesChange: () => {},
  sweepRun: null,
  onRunSweep: () => {},
  onStopSweep: () => {},
  onResetSweep: () => {},
  onViewRow: () => {},
} as any

describe('sweep integration', () => {
  it('sweep mode renders the matrix preview, not the single aside', () => {
    const html = renderToStaticMarkup(
      <NewRun
        {...common}
        mode="sweep"
        values={base}
        sweepAxes={toggleAxisValue({}, 'tp', '8', base)}
        loadValues={[base.loadValue, '32']}
        sweepRun={null}
      />,
    )
    expect(html).toMatch(/runs in one table/)
  })

  it('orchestration marks every cell done via the pool', async () => {
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue, '32'], [], [], [], [])
    const run = initSweepRun(e.runs)
    const post = vi.fn(async (_output: unknown) => ({ status: { complete: true } } as any))
    await runPool(run.cells, (c) => post(c.output), {
      onUpdate: (i, patch) => Object.assign(run.cells[i]!, patch),
      shouldStop: () => false,
    })
    expect(post).toHaveBeenCalledTimes(run.cells.length)
    expect(run.cells.length).toBeGreaterThan(0)
    expect(countsOf(run).done).toBe(run.cells.length)
  })
})
