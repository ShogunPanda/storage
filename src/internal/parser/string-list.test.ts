import { normalizeStringList, parseCommaSeparatedList } from './string-list'

describe('normalizeStringList', () => {
  it('returns undefined for absent or empty values', () => {
    expect(normalizeStringList(undefined)).toBeUndefined()
    expect(normalizeStringList([])).toBeUndefined()
    expect(normalizeStringList(['', '   '])).toBeUndefined()
  })

  it('trims, de-duplicates, and preserves order', () => {
    expect(normalizeStringList([' tenant-a ', 'tenant-b', 'tenant-a', ''])).toEqual([
      'tenant-a',
      'tenant-b',
    ])
  })
})

describe('parseCommaSeparatedList', () => {
  it('returns undefined for absent or empty input', () => {
    expect(parseCommaSeparatedList(undefined)).toBeUndefined()
    expect(parseCommaSeparatedList(' , , ')).toBeUndefined()
  })

  it('normalizes comma-separated input', () => {
    expect(parseCommaSeparatedList('tenant-a, tenant-b,tenant-a')).toEqual(['tenant-a', 'tenant-b'])
  })
})
