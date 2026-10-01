import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ModelEditor,
  draftFromDetail,
  draftModelYaml,
  draftToSubmission,
  emptyModelDraft,
  sourceFieldsFromYaml,
  type ModelDraft,
} from './components/ModelEditor'
import type { ModelValidation } from './models'

const noop = () => {}

const filledDraft: ModelDraft = {
  dir: 'qwen3-14b',
  provider: 'huggingface',
  repo: 'Qwen/Qwen3-14B',
  revision: 'main',
  retrieved: '',
  configJson: '{"architectures":["Qwen3ForCausalLM"]}',
}

describe('draftModelYaml', () => {
  it('builds a source block from the filled fields, omitting the blank ones', () => {
    const y = draftModelYaml(filledDraft)
    expect(y).toContain('provider: huggingface')
    expect(y).toContain('repo: Qwen/Qwen3-14B')
    expect(y).toContain('revision: main')
    // retrieved was blank, so it is not emitted.
    expect(y).not.toContain('retrieved')
  })
})

describe('draftToSubmission', () => {
  it('packages the dir, the generated model.yaml, and the config code box', () => {
    const s = draftToSubmission(filledDraft)
    expect(s.dir).toBe('qwen3-14b')
    expect(s.config_json).toBe('{"architectures":["Qwen3ForCausalLM"]}')
    expect(s.model_yaml).toContain('repo: Qwen/Qwen3-14B')
  })
})

describe('sourceFieldsFromYaml', () => {
  it('reads the source block into form fields', () => {
    const f = sourceFieldsFromYaml('source:\n  provider: hf\n  repo: Acme/X\n  revision: r1\n')
    expect(f).toEqual({ provider: 'hf', repo: 'Acme/X', revision: 'r1', retrieved: '' })
  })

  it('is all-blank for a yaml with no source block', () => {
    expect(sourceFieldsFromYaml('name: x\n')).toEqual({ provider: '', repo: '', revision: '', retrieved: '' })
  })
})

describe('draftFromDetail', () => {
  it('fills the dir, source fields, and config box from a model detail', () => {
    const d = draftFromDetail('acme/my-model', 'source:\n  repo: Acme/My-Model\n  provider: hf\n', '{"a":1}')
    expect(d.dir).toBe('my-model')
    expect(d.repo).toBe('Acme/My-Model')
    expect(d.provider).toBe('hf')
    expect(d.configJson).toBe('{"a":1}')
  })
})

function render(props: Partial<Parameters<typeof ModelEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    <ModelEditor
      draft={emptyModelDraft()}
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
  it('renders as a modal', () => {
    const html = render()
    expect(html).toContain('modal-scrim')
    expect(html).toContain('modal-wide')
    expect(html).toContain('role="dialog"')
  })

  it('offers a form for model.yaml and a code box for config.json, with upload buttons', () => {
    const html = render()
    // Structured model.yaml fields, not a raw YAML textarea.
    expect(html).toContain('name="provider"')
    expect(html).toContain('name="repo"')
    expect(html).toContain('name="revision"')
    expect(html).toContain('name="retrieved"')
    // config.json is a code box, labeled as such.
    expect(html).toContain('name="config_json"')
    expect(html.toLowerCase()).toContain('code box')
    // Upload-by-button for each.
    expect(html).toContain('Upload model.yaml')
    expect(html).toContain('Upload config.json')
  })

  it('hints each field with a Qwen example', () => {
    const html = render()
    expect(html).toContain('placeholder="qwen3-14b"')
    expect(html).toContain('placeholder="Qwen/Qwen3-14B"')
    expect(html).toContain('placeholder="huggingface"')
    // The config box placeholder shows a Qwen config shape.
    expect(html).toContain('Qwen3ForCausalLM')
  })

  it('carries the standing caveat that a validated model may not work', () => {
    const html = render().toLowerCase()
    expect(html).toContain('may not')
    expect(html).toMatch(/verify|trust|correct/)
  })

  it('disables Save until a passing verdict', () => {
    expect(render({ verdict: null })).toContain('class="primary" disabled=""')
    expect(
      render({
        verdict: { ok: false, canonical_name: 'acme/x', moe: false, provider: '', issues: ['blis rejected the model'] },
      }),
    ).toContain('class="primary" disabled=""')
  })

  it('enables Save on a passing verdict and shows the derived facts', () => {
    const ok = render({
      verdict: { ok: true, canonical_name: 'acme/my-model', moe: true, provider: 'huggingface', issues: [] },
    })
    expect(ok).toContain('class="primary"')
    expect(ok).not.toContain('class="primary" disabled=""')
    expect(ok).toContain('acme/my-model')
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
      draft: { ...emptyModelDraft(), dir: 'my-model', repo: 'Acme/My-Model' },
    })
    expect(html).toContain('Edit acme/my-model')
    expect(html).toMatch(/name="dir"[^>]*disabled|disabled[^>]*name="dir"/)
  })

  it('surfaces a save error', () => {
    expect(render({ saveError: 'the server is down' })).toContain('the server is down')
  })
})
