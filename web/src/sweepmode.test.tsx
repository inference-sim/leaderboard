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
  onStopSweep: () => {}, onResetSweep: () => {}, onViewRow: () => {},
}

describe('mode toggle', () => {
  it('renders both modes as two option cards, Single on by default', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="single" onModeChange={() => {}} />)
    expect(html).toContain('aria-label="Declaration mode"')
    expect(html).toMatch(/<div class="modecards" role="radiogroup"/)
    // both card titles and both descriptions render
    expect(html).toContain('Single run')
    expect(html).toContain('Sweep')
    expect(html).toContain('Run one candidate at one load.')
    expect(html).toContain('Run a matrix across load levels.')
    // the active card's label carries the `on` class with a checked radio; default is single
    expect(html).toMatch(
      /<label class="on"><input[^>]*name="declMode"[^>]*checked=""[^>]*\/>.*?<span class="mct">Single run<\/span>/,
    )
  })
  it('reflects sweep mode', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="sweep" onModeChange={() => {}} />)
    expect(html).toMatch(
      /<label class="on"><input[^>]*name="declMode"[^>]*checked=""[^>]*\/>.*?<span class="mct">Sweep<\/span>/,
    )
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

describe('subcard swept fields', () => {
  it('sweep mode makes each subcard swept control multi', () => {
    const html = renderToStaticMarkup(
      <NewRun
        {...common}
        mode="sweep"
        values={initialValues()}
        sweepAxes={{}}
        loadValues={[initialValues().loadValue]}
        sweepRun={null}
      />,
    )
    // RoutingCard: routing policy is not swept (it is entangled with routing scorers), so it
    // stays a single radio group even in sweep mode and never renders as a MultiToggle.
    expect(html).not.toContain('aria-label="Routing policy"')
    // PdCard: a pool count is a chip-number input; decider and contention are MultiToggle groups.
    expect(html).toContain('aria-label="Add Prefill instances"')
    expect(html).toContain('aria-label="Decider"')
    expect(html).toContain('aria-label="Transfer contention"')
    // KvOffloadCard: the CPU-offloading toggle is a MultiToggle group.
    expect(html).toContain('aria-label="CPU offloading"')
    // CustomCard: the default form is a custom workload, so its load level is a ChipList.
    expect(html).toContain('aria-label="Add a load level"')
  })
  it('sweep mode keeps routing policy as a single radio group, not a multi-toggle', () => {
    const html = renderToStaticMarkup(
      <NewRun
        {...common}
        mode="sweep"
        values={initialValues()}
        sweepAxes={{}}
        loadValues={[initialValues().loadValue]}
        sweepRun={null}
      />,
    )
    // Routing policy is entangled with routing scorers (not swept), so it stays single-valued
    // in sweep mode: the radio inputs render, and it is not a MultiToggle tagrow.
    expect(html).toContain('name="routingPolicy"')
    expect(html).not.toContain('aria-label="Routing policy"')
  })
  it('single mode keeps each subcard swept control single', () => {
    const html = renderToStaticMarkup(<NewRun {...common} mode="single" values={initialValues()} />)
    expect(html).not.toContain('aria-label="Routing policy"')
    expect(html).not.toContain('aria-label="Add Prefill instances"')
    expect(html).not.toContain('aria-label="Decider"')
    expect(html).not.toContain('aria-label="CPU offloading"')
    expect(html).not.toContain('aria-label="Add a load level"')
  })
})
