import type { RunRecord } from '../load'
import { reproCommand } from '../repro'
import { CopyBlock } from './CopyBlock'

/**
 * How to reproduce one run. The command shown is the exact argv the run stored, so
 * this is a record of what produced the numbers, not a fresh guess at how to remake
 * them — and because BLIS is deterministic, running it again gives the same result.
 * The caption under the "Reproduce …" title carries all of it — where to run it, why
 * it reproduces, and the temp metrics path — so nothing spills into a wide paragraph
 * that the table container would clip. Shared by the ranked table and the disqualified
 * band so the wording is single-sourced.
 */
export function ReproPanel({ record }: { record: RunRecord }) {
  return (
    <div className="repro">
      <CopyBlock
        label={`Reproduce ${record.run_id}`}
        hint={
          <>
            Run it from <code>{record.provenance.cwd}</code>, where blis reads its config.
            BLIS is deterministic, so seed {record.group.seed} on blis{' '}
            <code>{record.provenance.blis_commit}</code>
            {record.provenance.blis_tree_dirty && ' (dirty)'} reproduces it byte-for-byte.{' '}
            <code>--metrics-path</code> is a temp file; repoint it to keep the output.
          </>
        }
        text={reproCommand(record)}
      />
    </div>
  )
}
