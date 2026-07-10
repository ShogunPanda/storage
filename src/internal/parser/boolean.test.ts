import { parseOptionalBoolean } from './boolean'

const errorMessage = 'value must be either true or false'

describe('parseOptionalBoolean', () => {
  it('returns undefined for absent or empty input', () => {
    expect(parseOptionalBoolean(undefined, errorMessage)).toBeUndefined()
    expect(parseOptionalBoolean('   ', errorMessage)).toBeUndefined()
  })

  it('parses true and false case-insensitively', () => {
    expect(parseOptionalBoolean(' true ', errorMessage)).toBe(true)
    expect(parseOptionalBoolean('FALSE', errorMessage)).toBe(false)
  })

  it('rejects other boolean aliases', () => {
    expect(() => parseOptionalBoolean('yes', errorMessage)).toThrow(errorMessage)
  })
})
