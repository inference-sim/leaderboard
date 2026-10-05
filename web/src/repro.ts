/**
 * Reproducing a run. Every record stores the exact command that produced it in
 * provenance.argv, run from provenance.cwd — and BLIS is deterministic, so re-running
 * that argv gives the same numbers. This module turns the stored argv into something a
 * reader can copy, without rebuilding it: what shows is what ran.
 */

import type { RunRecord } from './load'

/**
 * One flag per line, continued with `\`, so a 25-flag command can be read. Lifted from
 * the New-run screen so the table and that screen render an argv the same way.
 *
 * A flag (`--…`) is paired with its value on one line, but a valueless bool flag like
 * `--enable-expert-parallel` sits on its own line: the next token is another flag, not
 * its value, so we must not consume it. Pairing two-at-a-time would glue the two flags
 * together and push the second flag's value onto a line of its own.
 */
export function shellLines(argv: string[]): string {
  const lines: string[] = [`${argv[0]} ${argv[1]}`]
  let i = 2
  while (i < argv.length) {
    const tok = argv[i] ?? ''
    const next = argv[i + 1]
    if (tok.startsWith('--') && next !== undefined && !next.startsWith('--')) {
      lines.push(`  ${tok} ${next}`)
      i += 2
    } else {
      lines.push(`  ${tok}`)
      i += 1
    }
  }
  return lines.join(' \\\n') + '\n'
}

/**
 * The exact, verbatim invocation for a run: the stored argv, one flag per line. It is
 * meant to be run from the recorded working directory (blis resolves its config files
 * relative to cwd), which the panel says alongside it rather than baking a `cd` into the
 * copied text. The temp `--metrics-path` is left as it was — it is where the run wrote
 * its output, and this is the record of what ran, not a freshly-built command.
 */
export function reproCommand(record: RunRecord): string {
  return shellLines(record.provenance.argv)
}
