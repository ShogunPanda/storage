import { parseNonNegativeInteger, parsePositiveInteger } from './integer'

const nonNegativeError = 'value must be a non-negative integer'
const positiveError = 'value must be a positive integer'

describe('parseNonNegativeInteger', () => {
  it('parses non-negative safe integers strictly', () => {
    expect(parseNonNegativeInteger('0', nonNegativeError)).toBe(0)
    expect(parseNonNegativeInteger(' 42 ', nonNegativeError)).toBe(42)
  })

  it.each(['-1', '1.5', '7x', '9007199254740992'])('rejects invalid input %s', (value) => {
    expect(() => parseNonNegativeInteger(value, nonNegativeError)).toThrow(nonNegativeError)
  })
})

describe('parsePositiveInteger', () => {
  it('parses positive safe integers strictly', () => {
    expect(parsePositiveInteger(' 42 ', positiveError)).toBe(42)
  })

  it.each(['0', '-1', '1.5', '7x', '9007199254740992'])('rejects invalid input %s', (value) => {
    expect(() => parsePositiveInteger(value, positiveError)).toThrow(positiveError)
  })
})
