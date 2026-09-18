import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmDialog } from './components/ConfirmDialog'
import { WorkloadCatalog } from './components/WorkloadCatalog'
import { WorkloadEditor } from './components/WorkloadEditor'
import { interpret, initialForm, type ProfileBody, type FormValues } from './workloads'

function body(name: string, specYaml?: string): ProfileBody {
  return interpret({ ...initialForm(), name, ...(specYaml ? { specYaml } : {}) }).body!
}

const noop = () => {}

describe('WorkloadCatalog', () => {
  it('lists each profile with its summary and variant', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog
        profiles={[body('chat-a'), body('chat-b')]}
        boardWorkloads={[]}
        onDelete={noop}
      />,
    )
    expect(html).toContain('chat-a')
    expect(html).toContain('chat-b')
    expect(html).toContain('spec-backed workload at 10 req/s aggregate')
    expect(html).toContain('workload-spec')
  })

  it('shows an empty state pointing at the form above when the catalog is empty', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={[]} boardWorkloads={[]} onDelete={noop} />,
    )
    expect(html.toLowerCase()).toContain('no workloads')
    expect(html).toContain('form above')
  })

  it('badges a preset read-only and disables its Delete action', () => {
    const preset: ProfileBody = { ...body('chatbot'), builtin: true }
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={[preset]} boardWorkloads={[]} onDelete={noop} />,
    )
    expect(html.toLowerCase()).toContain('preset') // the read-only badge
    // A preset cannot be deleted from the catalog (§11.2). Delete is the only card action —
    // a saved workload is never edited in place.
    expect(html).toMatch(/<button[^>]*disabled[\s\S]*?Delete/)
    expect(html).not.toContain('>Edit<')
  })

  it('leaves a user profile’s actions enabled', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={[body('mine')]} boardWorkloads={[]} onDelete={noop} />,
    )
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })

  it('shows a prompt to pick a card when nothing is selected', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={[body('chat-a')]} boardWorkloads={[]} onDelete={noop} />,
    )
    // No spec panel until a card is chosen.
    expect(html).not.toContain('aggregate_rate')
    expect(html.toLowerCase()).toContain('select a workload')
  })

  it('shows the selected spec-backed profile’s full spec and group knobs', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog
        profiles={[body('chat-a'), body('chat-b')]}
        boardWorkloads={[]}
        selected="chat-a"
        onSelect={noop}
        onDelete={noop}
      />,
    )
    // The detail panel carries the complete WorkloadSpec YAML and the group knobs.
    expect(html).toContain('aggregate_rate')
    expect(html).toContain('seed 42')
    // The chosen card is marked selected for the reader.
    expect(html).toMatch(/aria-pressed="true"/)
    // The selected row carries the fixed scroll anchor the deep link scrolls to.
    expect(html).toMatch(/<li[^>]*id="wrow-selected"/)
  })

  it('puts the scroll anchor only on the selected row', () => {
    const html = renderToStaticMarkup(
      <WorkloadCatalog
        profiles={[body('chat-a'), body('chat-b')]}
        boardWorkloads={[]}
        onDelete={noop}
      />,
    )
    // Nothing selected: no anchor for the deep link to scroll to.
    expect(html).not.toContain('id="wrow-selected"')
  })

  it('shows a distribution profile’s flat definition, which has no spec', () => {
    const dist: ProfileBody = {
      name: 'legacy',
      seed: 7,
      horizon_ticks: null,
      request_timeout_s: 300,
      workload: {
        type: 'distribution',
        num_requests: 500,
        load: { kind: 'rate', value: 6 },
        prompt_tokens: 512,
        prompt_tokens_stdev: 256,
        output_tokens: 128,
        output_tokens_stdev: 64,
      },
    }
    const html = renderToStaticMarkup(
      <WorkloadCatalog
        profiles={[dist]}
        boardWorkloads={[]}
        selected="legacy"
        onSelect={noop}
        onDelete={noop}
      />,
    )
    expect(html).toContain('seed 7')
    expect(html).toContain('500') // request count
    expect(html).toContain('512') // prompt tokens
    // A distribution has no WorkloadSpec YAML to show.
    expect(html).not.toContain('aggregate_rate')
  })
})

describe('ConfirmDialog', () => {
  it('renders nothing while closed, so nothing is deleted without opening it', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open={false} title="Delete workload?" onConfirm={noop} onCancel={noop}>
        Delete <code>mine</code>?
      </ConfirmDialog>,
    )
    expect(html).toBe('')
  })

  it('renders an accessible dialog with the warning and both actions when open', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open title="Delete workload?" confirmLabel="Delete" onConfirm={noop} onCancel={noop}>
        Delete <code>mine</code>? Runs already on the board keep their own copy.
      </ConfirmDialog>,
    )
    expect(html).toMatch(/role="dialog"/)
    expect(html).toMatch(/aria-modal="true"/)
    // The title is wired to the dialog for a screen reader.
    expect(html).toMatch(/aria-labelledby="confirm-dialog-title"/)
    expect(html).toMatch(/id="confirm-dialog-title"[^>]*>Delete workload\?/)
    expect(html).toContain('keep their own copy')
    // Both a way out and the destructive confirm are offered.
    expect(html).toContain('>Cancel<')
    expect(html).toMatch(/class="danger-solid"[^>]*>Delete</)
  })
})

describe('WorkloadEditor', () => {
  const base: Parameters<typeof WorkloadEditor>[0] = {
    values: { ...initialForm(), name: 'chat-6rps' } as FormValues,
    onChange: noop,
    onSave: noop,
    onCancel: noop,
    verdict: null,
    saving: false,
    saveError: null,
  }

  it('renders both panes: the spec form and the YAML pane, in sync', () => {
    const html = renderToStaticMarkup(<WorkloadEditor {...base} />)
    expect(html).toContain('WorkloadSpec YAML') // the YAML pane
    expect(html).toContain('aggregate_rate') // a form field label
    expect(html).toContain('textarea')
    // The YAML pane shows the same spec the form is bound to.
    expect(html).toContain('aggregate_rate: 10')
  })

  it('shows the parse error in place of the form fields when the YAML is broken', () => {
    const html = renderToStaticMarkup(
      <WorkloadEditor {...base} values={{ ...base.values, specYaml: 'clients: [oops' }} />,
    )
    expect(html).toContain('the form returns')
  })

  it('offers Reset all beside the Name field', () => {
    const html = renderToStaticMarkup(<WorkloadEditor {...base} />)
    expect(html).toContain('Reset all')
  })

  it('gives each client a remove control', () => {
    const twoClients =
      'version: "2"\naggregate_rate: 10\nclients:\n  - id: c0\n    rate_fraction: 0.5\n  - id: c1\n    rate_fraction: 0.5\n'
    const html = renderToStaticMarkup(<WorkloadEditor {...base} values={{ ...base.values, specYaml: twoClients }} />)
    // One "Remove client …" control per client card.
    expect(html.match(/aria-label="Remove client/g)).toHaveLength(2)
  })

  it('disables Save while the form has issues', () => {
    const html = renderToStaticMarkup(<WorkloadEditor {...base} values={{ ...base.values, name: '' }} />)
    expect(html).toMatch(/<button[^>]*disabled/)
  })

  it('shows the twin warning and blis issues from the verdict', () => {
    const html = renderToStaticMarkup(
      <WorkloadEditor
        {...base}
        verdict={{
          ok: false,
          variant: 'workload-spec',
          summary: 's',
          twin: 'chat-6rps',
          issues: ['parsing workload spec: bad'],
        }}
      />,
    )
    // The twin name is set off as a name, not run into the prose, so "chat-6rps"
    // reads as the workload it collides with rather than a stray word.
    expect(html).toContain('<code>chat-6rps</code>')
    expect(html).toContain('parsing workload spec: bad')
  })
})
