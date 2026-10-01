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
    workload: {
      type: 'workload-spec',
      spec: {
        version: '2', category: 'language', aggregate_rate: 6, num_requests: 500,
        clients: [
          {
            id: 'c0', rate_fraction: 1, arrival: { process: 'constant' },
            input_distribution: { type: 'gaussian', params: { mean: 512, std_dev: 128, min: 2, max: 7000 } },
            output_distribution: { type: 'gaussian', params: { mean: 128, std_dev: 32, min: 2, max: 7000 } },
          },
        ],
      },
    },
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

  it('tags each saved workload with its load kind: concurrency for a trace (even one session), rate for a rate spec', () => {
    const profiles = [dist('chatbot'), trace('weka-jsonl1', 1000)]
    const html = renderToStaticMarkup(
      <WorkloadCatalog profiles={profiles} boardWorkloads={[]} onDelete={() => {}} />,
    )
    // The trace's pool is one concurrent session, yet it still carries the concurrency tag.
    expect(html).toContain('tag-concurrency')
    expect(html).toContain('>concurrency<')
    // The rate spec carries the rate tag.
    expect(html).toContain('tag-rate')
    expect(html).toContain('>rate<')
  })
})
