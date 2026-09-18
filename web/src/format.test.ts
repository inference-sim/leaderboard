import { describe, expect, it } from 'vitest'
import { formatCount, formatMs, formatNumber } from './format'

describe('formatMs', () => {
  it('reads sub-second values in milliseconds to one decimal', () => {
    expect(formatMs(31.42823)).toBe('31.4ms')
    expect(formatMs(999.9)).toBe('999.9ms')
  })

  it('switches to seconds at a second, because 9749.57ms is unreadable', () => {
    expect(formatMs(9749.57464)).toBe('9.75s')
    expect(formatMs(1000)).toBe('1.00s')
  })

  it('renders a missing value as an em dash rather than a zero', () => {
    expect(formatMs(null)).toBe('—')
  })
})

describe('formatNumber', () => {
  it('groups thousands and honours the requested precision', () => {
    expect(formatNumber(1078.9384, 1)).toBe('1,078.9')
    expect(formatNumber(5.478, 2)).toBe('5.48')
    expect(formatNumber(0, 0)).toBe('0')
  })
  it('renders null as an em dash', () => {
    expect(formatNumber(null, 1)).toBe('—')
  })
})

describe('formatCount', () => {
  it('renders integers with grouping and no decimals', () => {
    expect(formatCount(500)).toBe('500')
    expect(formatCount(248510)).toBe('248,510')
  })
})
