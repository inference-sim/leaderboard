import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelEditor, type ModelDraft } from './components/ModelEditor'
import type { ModelValidation } from './models'

const noop = () => {}
const emptyDraft: ModelDraft = { dir: '', modelYaml: '', configJson: '' }

function render(props: Partial<Parameters<typeof ModelEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    <ModelEditor
      draft={emptyDraft}
      editingName={null}
      verdict={null}
      validating={false}
      saving={false}
      saveError={null}
      onChange={noop}
      onValidate={noop}
      onSave={noop}
      onCancel={noop}
      {...props}
    />,
  )
}

describe('ModelEditor', () => {
  it('carries the standing caveat that a validated model may not work', () => {
    const html = render().toLowerCase()
    expect(html).toContain('may not')
    // It names what validation does and does not prove.
    expect(html).toMatch(/verify|trust|correct/)
  })

  it('disables Save until a passing verdict', () => {
    const disabled = render({ verdict: null })
    expect(disabled).toContain('class="primary" disabled=""')

    const stillDisabled = render({
      verdict: { ok: false, canonical_name: 'acme/x', moe: false, provider: '', issues: ['blis rejected the model'] },
    })
    expect(stillDisabled).toContain('class="primary" disabled=""')
  })

  it('enables Save on a passing verdict', () => {
    const ok = render({
      verdict: { ok: true, canonical_name: 'acme/my-model', moe: true, provider: 'huggingface', issues: [] },
    })
    // The primary button is present and not disabled.
    expect(ok).toContain('class="primary"')
    expect(ok).not.toContain('class="primary" disabled=""')
    // The derived facts are shown.
    expect(ok).toContain('acme/my-model')
    expect(ok).toContain('huggingface')
  })

  it('lists the issues a failing verdict carries', () => {
    const bad: ModelValidation = {
      ok: false,
      canonical_name: 'acme/x',
      moe: false,
      provider: '',
      issues: ['config.json is not valid JSON', 'blis rejected the model'],
    }
    const html = render({ verdict: bad })
    expect(html).toContain('config.json is not valid JSON')
    expect(html).toContain('blis rejected the model')
  })

  it('names the model and locks the directory when editing', () => {
    const html = render({
      editingName: 'acme/my-model',
      draft: { dir: 'my-model', modelYaml: 'source:\n  repo: Acme/My-Model\n', configJson: '{}' },
    })
    expect(html).toContain('Edit acme/my-model')
    // The directory is the model's identity, so it cannot be renamed in place. The disabled
    // attribute may render on either side of name= depending on React's attribute order.
    expect(html).toMatch(/name="dir"[^>]*disabled|disabled[^>]*name="dir"/)
  })

  it('surfaces a save error', () => {
    const html = render({ saveError: 'the server is down' })
    expect(html).toContain('the server is down')
  })
})
