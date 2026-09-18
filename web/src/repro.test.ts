import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { reproCommand, shellLines } from './repro'

const records = fixture as unknown as RunRecord[]

describe('shellLines (one flag per line, for a readable command)', () => {
  it('puts the subcommand on the first line and each flag/value pair on its own continued line', () => {
    const out = shellLines(['./blis', 'run', '--model', 'm', '--tp', '2'])
    expect(out).toBe('./blis run \\\n  --model m \\\n  --tp 2\n')
  })

  it('renders a trailing flag with no value without a dangling space', () => {
    // argv is normally even past the subcommand, but a bare final flag must not
    // become "--flag " with trailing whitespace a shell would carry into an arg.
    const out = shellLines(['./blis', 'run', '--verbose'])
    expect(out).toBe('./blis run \\\n  --verbose\n')
  })
})

describe('reproCommand (the exact, verbatim invocation for a run)', () => {
  const record = records[0]!
  const cmd = reproCommand(record)

  it('is the stored argv, shell-formatted, with no cd baked in', () => {
    // Where to run it (../inference-sim) is said in the panel, not prepended to the
    // copied text — a `cd` in the clipboard is a surprise when pasted.
    expect(cmd).toBe(shellLines(record.provenance.argv))
    expect(cmd.startsWith('./blis run \\\n')).toBe(true)
    expect(cmd).not.toContain('cd ')
  })

  it('reproduces the stored argv verbatim, every token, including the temp --metrics-path', () => {
    // The point of showing provenance.argv rather than rebuilding it: it is exactly
    // what ran, temp metrics path and all, and BLIS is deterministic from it.
    for (const token of record.provenance.argv) expect(cmd).toContain(token)
    const metricsPath = record.provenance.argv[record.provenance.argv.length - 1]
    expect(cmd).toContain(`--metrics-path ${metricsPath}`)
  })
})
