import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Knob } from './components/Knob'

describe('Knob', () => {
  it('renders a scalar chip as a single boxed token', () => {
    const html = renderToStaticMarkup(<Knob chip={{ label: 'max_num_seqs 8', extra: false }} />)
    expect(html).toBe('<span class="knob">max_num_seqs 8</span>')
  })

  it('marks an extra_flags chip with the warn styling', () => {
    const html = renderToStaticMarkup(<Knob chip={{ label: '--prefix-tokens 64', extra: true }} />)
    expect(html).toContain('class="knob extra"')
  })

  it('renders a structured chip as its field name plus one token per item', () => {
    const html = renderToStaticMarkup(
      <Knob
        chip={{
          label: 'routing_scorers',
          extra: false,
          items: ['precise-prefix-cache ×2', 'queue-depth ×1'],
        }}
      />,
    )
    expect(html).toContain('class="knobgroup"')
    expect(html).toContain('<i class="knobgroup-label">routing_scorers</i>')
    expect(html).toContain('>precise-prefix-cache ×2</span>')
    expect(html).toContain('>queue-depth ×1</span>')
    // The whole point: the object never reaches the DOM as "[object Object]".
    expect(html).not.toContain('object Object')
  })

  it('keeps the dotted rest styling on a grouped field folded into "show all"', () => {
    const html = renderToStaticMarkup(
      <Knob rest chip={{ label: 'disaggregation', extra: false, items: ['prefill 2', 'decode 2'] }} />,
    )
    expect(html).toContain('class="knob rest"')
  })
})
