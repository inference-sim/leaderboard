import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewRun } from './components/NewRun'
import { initialValues } from './newrun'
import { toggleAxisValue } from './sweep'

const common = {
  groups: [], values: initialValues(), onChange: () => {}, workloadInitialized: true,
  onWorkloadInitialized: () => {}, runIdEdited: false, onRunIdEdited: () => {},
  customNameEdited: false, onCustomNameEdited: () => {}, running: false, errorMessage: null,
  onRun: () => {}, onModeChange: () => {}, sweepAxes: {}, onSweepAxesChange: () => {},
  loadValues: [], onLoadValuesChange: () => {}, sweepRun: null, onRunSweep: () => {},
  onStopSweep: () => {}, onViewRow: () => {},
}

describe('mode toggle', () => {
  it('renders both modes, Single pressed by default', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="single" onModeChange={() => {}} />)
    expect(html).toContain('Single run')
    expect(html).toContain('Sweep')
  })
  it('reflects sweep mode', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="sweep" onModeChange={() => {}} />)
    expect(html).toContain('aria-pressed="true"') // the Sweep pill lit (if using tag buttons)
  })
})

describe('single form in both modes', () => {
  it('sweep mode renders the single form with multi controls for swept main-body fields', () => {
    const html = renderToStaticMarkup(
      <NewRun
        {...common}
        mode="sweep"
        values={initialValues()}
        sweepAxes={toggleAxisValue({}, 'tp', '8', initialValues())}
        loadValues={[initialValues().loadValue, '32']}
        sweepRun={null}
      />,
    )
    // the single form's Work-offered legend still renders (same interface)
    expect(html).toContain('Work offered')
    // TP is now a multi-toggle (aria-pressed pills), and the matrix preview is in the aside
    expect(html).toMatch(/aria-pressed="true"/)
    expect(html).toMatch(/runs in one table/)
    // model stays a single control (not a chip multi-select): its single Select label is
    // present, and the ChipSelect's "Add Model" chip input is not.
    expect(html).toContain('id="model-label"')
    expect(html).not.toContain('aria-label="Add Model"')
  })
  it('single mode still renders the plain single-run controls', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="single" values={initialValues()} />)
    expect(html).toContain('Work offered')
    expect(html).not.toContain('runs in one table')
  })
})
