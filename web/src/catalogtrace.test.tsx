import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkloadCatalog } from './components/WorkloadCatalog'
import type { ProfileBody } from './workloads'

function trace(name: string, timeout: number): ProfileBody {
  return {
    name, seed: 42, horizon_ticks: null, request_timeout_s: timeout,
    workload: {
      type: 'trace',
      trace: {
        sha256: '783919229d495af2506a9a4235ecbeed7a340764f98d27a81c0dc174c7c1085a',
        session_mode: 'closed-loop', concurrent_sessions: 1, total_sessions: 10,
        shuffle_corpus: true, think_time_ms: 30, think_time_dist: '', source_format: 'weka',
        records: 26648, sessions: 183, session_context_growth: 'accumulate',
      },
    },
  }
}
function dist(name: string): ProfileBody {
  return {
    name, seed: 42, horizon_ticks: null, request_timeout_s: 300,
    workload: { type: 'distribution', num_requests: 500, load: { kind: 'rate', value: 6 }, prompt_tokens: 512, prompt_tokens_stdev: 128, output_tokens: 128, output_tokens_stdev: 32 },
    builtin: true,
  }
}

describe('WorkloadCatalog with trace profiles', () => {
  it('renders every profile row, including two same-trace variants', () => {
    const profiles = [dist('chatbot'), trace('weka-jsonl1', 1000), trace('weka-jsonl2', 3000)]
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={profiles} boardWorkloads={[]} onDelete={() => {}} />,
    )
    for (const n of ['chatbot', 'weka-jsonl1', 'weka-jsonl2']) {
      expect(html, `missing ${n}`).toContain(n)
    }
  })
})
