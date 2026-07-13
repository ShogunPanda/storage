import { parsePprofCommand } from './pprof-client'

describe('parsePprofCommand', () => {
  const now = new Date('2026-07-13T14:00:00.000Z')

  it('parses capture commands', () => {
    expect(
      parsePprofCommand(['capture', 'profile', '--seconds', '30', '--output', 'cpu.pb'])
    ).toEqual({
      name: 'capture',
      target: 'profile',
      seconds: 30,
      output: 'cpu.pb',
      generateFlame: false,
    })
    expect(parsePprofCommand(['capture', 'heap', '--flame'])).toMatchObject({
      name: 'capture',
      target: 'heap',
      seconds: 30,
      generateFlame: true,
    })
    expect(parsePprofCommand(['capture', 'heap-snapshot'])).toEqual({
      name: 'capture',
      target: 'heap-snapshot',
      seconds: undefined,
      output: undefined,
      generateFlame: false,
    })
  })

  it('parses stored profile commands', () => {
    expect(
      parsePprofCommand(
        ['list', '--class', 'auto', '--service', 'storage-api', '--kind', 'cpu', '--limit', '25'],
        now
      )
    ).toEqual({
      name: 'list',
      class: 'auto',
      service: 'storage-api',
      kind: 'cpu',
      date: '2026-07-13',
      limit: 25,
      cursor: undefined,
    })
    expect(parsePprofCommand(['detail', 'abc_123'])).toEqual({ name: 'detail', id: 'abc_123' })
    expect(parsePprofCommand(['download', 'abc-123'])).toEqual({
      name: 'download',
      id: 'abc-123',
      output: undefined,
      generateFlame: false,
    })
    expect(parsePprofCommand(['download', 'abc-123', '--flame'])).toEqual({
      name: 'download',
      id: 'abc-123',
      output: undefined,
      generateFlame: true,
    })
  })

  it('selects UTC profile dates', () => {
    expect(parsePprofCommand(['list', '--class', 'auto', '--days-ago', '1'], now)).toMatchObject({
      date: '2026-07-12',
    })
    expect(
      parsePprofCommand(['list', '--class', 'auto', '--date', '2026-07-01'], now)
    ).toMatchObject({ date: '2026-07-01' })
    expect(parsePprofCommand(['list', '--class', 'auto', '--all'], now)).toMatchObject({
      date: undefined,
    })
  })

  it('rejects invalid commands and options', () => {
    expect(() => parsePprofCommand(['profile'])).toThrow('Usage:')
    expect(() => parsePprofCommand(['capture', 'profile', '--seconds', '0'])).toThrow(
      'seconds must be a positive integer'
    )
    expect(() => parsePprofCommand(['capture', 'heap-snapshot', '--seconds', '10'])).toThrow(
      '--seconds is not valid'
    )
    expect(() => parsePprofCommand(['capture', 'heap-snapshot', '--flame'])).toThrow(
      '--flame is not valid'
    )
    expect(() => parsePprofCommand(['list', '--class', 'automatic'])).toThrow(
      '--class must be auto or manual'
    )
    expect(() =>
      parsePprofCommand(['list', '--class', 'auto', '--date', '2026-02-30'], now)
    ).toThrow('date must use YYYY-MM-DD')
    expect(() =>
      parsePprofCommand(['list', '--class', 'auto', '--days-ago', '1', '--all'], now)
    ).toThrow('mutually exclusive')
    expect(() => parsePprofCommand(['detail', '../key'])).toThrow('id must be base64url text')
  })
})
