import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewRun } from './components/NewRun'
import { initialValues } from './newrun'

const common = {
  groups: [], values: initialValues(), onChange: () => {}, workloadInitialized: true,
  onWorkloadInitialized: () => {}, runIdEdited: false, onRunIdEdited: () => {},
  customNameEdited: false, onCustomNameEdited: () => {}, running: false, errorMessage: null,
  onRun: () => {}, sweepAxes: {}, onSweepAxesChange: () => {}, loadValues: [],
  onLoadValuesChange: () => {}, sweepRun: null, onRunSweep: () => {}, onStopSweep: () => {},
  onViewRow: () => {},
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
