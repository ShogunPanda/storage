import { describe, expect, it } from 'vitest'
import { BatchQuery } from './batch-query.js'

// Records what a query writes, in order, as pg's connection would send it.
function recordingConnection() {
  const written: string[] = []
  const connection = {
    stream: {
      cork: () => written.push('cork'),
      uncork: () => written.push('uncork'),
    },
    parse: ({ text }: { text: string }) => written.push(`parse ${text}`),
    bind: ({ values }: { values: unknown[] }) => written.push(`bind ${JSON.stringify(values)}`),
    describe: () => written.push('describe'),
    execute: () => written.push('execute'),
    flush: () => written.push('flush'),
    sync: () => written.push('sync'),
    sendCopyFail: (message: string) => written.push(`copyFail ${message}`),
  }
  return { connection: connection as never, written }
}

const field = (name: string) => ({ name, dataTypeID: 25 }) as never

describe('BatchQuery', () => {
  it('writes every statement at once, with a Flush after BEGIN and a single Sync', () => {
    const query = new BatchQuery([{ text: 'SELECT 1' }, { text: 'SELECT 2' }], 'BEGIN', 'COMMIT')
    const { connection, written } = recordingConnection()

    expect(query.submit(connection)).toBeUndefined()

    const statement = (text: string) => [`parse ${text}`, 'bind []', 'describe', 'execute']
    expect(written).toEqual([
      'cork',
      ...statement('BEGIN'),
      'flush',
      ...statement('SELECT 1'),
      ...statement('SELECT 2'),
      ...statement('COMMIT'),
      'sync',
      'uncork',
    ])
  })

  it('writes no Flush without BEGIN', () => {
    const query = new BatchQuery([{ text: 'SELECT 1' }, { text: 'SELECT 2' }])
    const { connection, written } = recordingConnection()

    query.submit(connection)

    expect(written.filter((message) => message === 'flush' || message === 'sync')).toEqual(['sync'])
  })

  it('maps parameters as pg does', () => {
    const query = new BatchQuery([
      { text: 'SELECT $1, $2, $3, $4', values: [null, 1, { a: 1 }, ['x', 'y']] },
    ])
    const { connection, written } = recordingConnection()

    query.submit(connection)

    expect(written).toContain(`bind ${JSON.stringify([null, '1', '{"a":1}', '{"x","y"}'])}`)
  })

  it('fails before writing anything when a parameter cannot be sent', () => {
    const cyclic = {
      toPostgres: () => cyclic,
    }
    const query = new BatchQuery([{ text: 'SELECT 1' }, { text: 'SELECT $1', values: [cyclic] }])
    const { connection, written } = recordingConnection()

    expect(query.submit(connection)).toBeInstanceOf(Error)
    expect(written).toEqual([])
  })

  it("returns each statement's rows, fields and row count, without BEGIN's or COMMIT's", async () => {
    const query = new BatchQuery(
      [{ text: 'SELECT name FROM t' }, { text: 'UPDATE t SET n = 1' }],
      'BEGIN',
      'COMMIT'
    )

    query.handleCommandComplete({ text: 'BEGIN' })
    expect(query.beganTransaction).toBe(true)
    query.handleRowDescription({ fields: [field('name')] })
    query.handleDataRow({ fields: ['a'] })
    query.handleDataRow({ fields: [null] })
    query.handleCommandComplete({ text: 'SELECT 2' })
    query.handleCommandComplete({ text: 'UPDATE 3' })
    query.handleCommandComplete({ text: 'COMMIT' })
    query.handleReadyForQuery()

    expect(await query.promise).toEqual([
      { command: 'SELECT', rowCount: 2, oid: 0, fields: [field('name')], rows: [['a'], [null]] },
      { command: 'UPDATE', rowCount: 3, oid: 0, fields: [], rows: [] },
    ])
  })

  it('knows whether it was written', () => {
    const query = new BatchQuery([{ text: 'SELECT 1' }], 'BEGIN', 'COMMIT')
    expect(query.submitted).toBe(false)
    query.submit(recordingConnection().connection)
    expect(query.submitted).toBe(true)

    // A value pg cannot send fails the query before anything is written.
    const unsendable = {
      toPostgres: () => {
        throw new Error('cannot send')
      },
    }
    const invalid = new BatchQuery([{ text: 'SELECT $1', values: [unsendable] }], 'BEGIN')
    expect(invalid.submit(recordingConnection().connection)).toBeInstanceOf(Error)
    expect(invalid.submitted).toBe(false)
  })

  it('knows whether BEGIN replied before a failure', async () => {
    const failed = new BatchQuery([{ text: 'SELECT 1' }], 'BEGIN', 'COMMIT')
    failed.handleError(new Error('no more connections allowed'))
    expect(failed.beganTransaction).toBe(false)
    await expect(failed.promise).rejects.toThrow('no more connections allowed')

    const begun = new BatchQuery([{ text: 'SELECT 1' }], 'BEGIN', 'COMMIT')
    begun.handleCommandComplete({ text: 'BEGIN' })
    begun.handleError(new Error('boom'))
    expect(begun.beganTransaction).toBe(true)
    await expect(begun.promise).rejects.toThrow('boom')

    // Without BEGIN there is no transaction setup to fail.
    expect(new BatchQuery([{ text: 'SELECT 1' }]).beganTransaction).toBe(true)
  })

  it('settles once: a ReadyForQuery after an error changes nothing', async () => {
    const query = new BatchQuery([{ text: 'SELECT 1' }])
    query.handleError(new Error('first'))
    query.handleReadyForQuery()
    query.handleError(new Error('second'))

    await expect(query.promise).rejects.toThrow('first')
  })
})
