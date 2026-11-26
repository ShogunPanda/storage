import { removeGlobals, updateGlobals } from '@platformatic/globals'
import { DatabaseError } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseExecutor } from '../connection'
import { searchPath, type TenantConnectionOptions } from '../pool'
import type { DatabaseWattTransport } from './client'
import { getWattPostgresConnection, WattPgExecutor } from './connection'

type SentWattMessage = {
  application: string
  data: Record<string, unknown>
  message: string
}

function installWattMessagingMock(responses: Record<string, unknown> = {}): {
  sent: SentWattMessage[]
} {
  const sent: SentWattMessage[] = []

  updateGlobals({
    messaging: {
      handle: vi.fn(),
      notify: vi.fn(),
      getWorkers: vi.fn(),
      getWorkerForAffinity: vi.fn(),
      onWorkersChange: vi.fn(),
      send: vi.fn(async (application: string, message: string, data: Record<string, unknown>) => {
        sent.push({ application, data, message })
        const response = responses[message]
        return response instanceof Promise ? response : response
      }),
    },
  })

  return { sent }
}

afterEach(() => {
  removeGlobals(['messaging'])
})

describe('Watt PostgreSQL connection adapter', () => {
  it('adapts an injected Watt transport without Platformatic messaging', async () => {
    const transport: DatabaseWattTransport = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] }),
      acquire: vi.fn(),
      batch: vi.fn(),
      lockedBatch: vi.fn(),
      lockedQuery: vi.fn(),
      release: vi.fn(),
      beginTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      rollbackTransaction: vi.fn(),
    }
    const executor = new WattPgExecutor(createPoolTarget(), () => 'operation-a', transport)

    const result = await executor.query<{ id: number }>('SELECT $1::int AS id', [1])

    expect(result).toMatchObject({ rowCount: 1, rows: [{ id: 1 }] })
    expect(transport.query).toHaveBeenCalledWith(
      {
        destination: createPoolTarget(),
        operationName: 'operation-a',
        sql: 'SELECT $1::int AS id',
        values: [1],
      },
      { signal: undefined }
    )
  })

  it('sends stateless queries through Database Watt messaging', async () => {
    const { sent } = installWattMessagingMock({
      'database.query': { rowCount: 1, rows: [{ id: 1 }] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const result = await connection.query<{ id: number }>({
      text: 'SELECT $1::int as id',
      values: [1],
    })

    expect(result.rows).toEqual([{ id: 1 }])
    expect(result.rowCount).toBe(1)
    expect(sent[0]).toMatchObject({
      application: 'database',
      message: 'database.query',
      data: {
        destination: createPoolTarget(),
        operationName: 'operation-a',
        sql: 'SELECT $1::int as id',
        values: [1],
      },
    })
    expect(sent[0].data.requestId).toEqual(expect.any(String))
  })

  it('opens a transaction with its first query and commits it by lock', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 1, rows: [{ ok: true }] },
      'database.lockedQuery': { rowCount: 1, rows: [{ ok: false }] },
      'database.commitTransaction': { committed: true },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction({
      isolation: 'serializable',
      readOnly: true,
      timeout: 5_000,
    })
    expect(sent).toHaveLength(0)

    const first = await tx.query('SELECT 1')
    const second = await tx.query('SELECT 2')
    await tx.commit()

    expect(first.rows).toEqual([{ ok: true }])
    expect(second.rows).toEqual([{ ok: false }])
    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.lockedQuery',
      'database.commitTransaction',
    ])
    // BEGIN, the deferred statement timeout and the first query travel together.
    expect(sent[0].data).toMatchObject({
      destination: createPoolTarget(),
      isolationLevel: 'SERIALIZABLE',
      readOnly: true,
      commit: false,
      statements: [
        { sql: "SELECT set_config('statement_timeout', $1, true)", values: ['5000ms'] },
        { sql: 'SELECT 1' },
      ],
    })
    expect(sent[1].data).toMatchObject({ lockId: 'lock-a', sql: 'SELECT 2' })
    expect(sent[2].data).toMatchObject({ lockId: 'lock-a' })
    expect(tx.isCompleted()).toBe(true)
  })

  it('folds transaction settings into the scope statement sent with the first query', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 1, rows: [{ ok: true }] },
    })
    const connection = await getWattPostgresConnection({
      ...createConnectionOptions(),
      isExternalPool: true,
    })

    const tx = await connection.transaction({ timeout: 5_000 })
    await connection.setScope(tx)
    await tx.query('SELECT 1')

    expect(sent.map((message) => message.message)).toEqual(['database.batch'])
    const statements = sent[0].data.statements as Array<{ sql: string; values?: unknown[] }>
    expect(statements).toHaveLength(2)
    expect(statements[0].sql).toContain("set_config('role', $1, true)")
    expect(statements[0].sql).toContain("set_config('statement_timeout', $10, true)")
    expect(statements[0].sql).toContain("set_config('search_path', $11, true)")
    expect((statements[0].values as unknown[]).slice(9)).toEqual(['5000ms', searchPath.join(',')])
    expect(statements[1]).toMatchObject({ sql: 'SELECT 1' })
  })

  it('sends a scope set after the transaction started with the next query', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedBatch': {
        rowCount: 1,
        rows: [['1']],
        fields: [{ name: 'n', dataTypeID: 23 }],
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction()
    await tx.query('SELECT 0')
    await connection.asSuperUser().setScope(tx)
    const result = await tx.query('SELECT 1 AS n')

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.lockedBatch',
    ])
    const statements = sent[1].data.statements as Array<{ sql: string; values?: unknown[] }>
    expect(statements).toHaveLength(2)
    expect(statements[0].sql).toContain("set_config('role', $1, true)")
    expect(statements[0].values?.[0]).toBe('service_role')
    expect(statements[1]).toEqual({ sql: 'SELECT 1 AS n', values: undefined })
    expect(result.rows).toEqual([{ n: 1 }])
  })

  it('sends deferred statements with COMMIT and drops them on ROLLBACK', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.commitTransaction': { committed: true },
      'database.rollbackTransaction': { rolledBack: true },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const committed = await connection.transaction()
    await committed.query('SELECT 1')
    committed.defer?.({ text: 'RELEASE SAVEPOINT a' })
    await committed.commit()

    const rolledBack = await connection.transaction()
    await rolledBack.query('SELECT 1')
    rolledBack.defer?.({ text: 'ROLLBACK TO SAVEPOINT a' })
    await rolledBack.rollback()

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.commitTransaction',
      'database.batch',
      'database.rollbackTransaction',
    ])
    expect(sent[1].data).toMatchObject({
      lockId: 'lock-a',
      statements: [{ sql: 'RELEASE SAVEPOINT a' }],
    })
    expect(sent[3].data).not.toHaveProperty('statements')
  })

  it('keeps deferred statements queued when a query is aborted before it is sent', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedBatch': { rowCount: 0, rows: [] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())
    const aborted = new AbortController()
    aborted.abort()

    const tx = await connection.transaction()
    await tx.query('SELECT 0')
    tx.defer?.({ text: 'SAVEPOINT a' })
    await expect(tx.query('SELECT 1', { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await tx.query('SELECT 2')

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.lockedBatch',
    ])
    expect(sent[1].data.statements).toEqual([
      { sql: 'SAVEPOINT a', values: undefined },
      { sql: 'SELECT 2', values: undefined },
    ])
  })

  it('only rolls back a transaction whose deferred statements went with an aborted query', async () => {
    const lockedBatch = Promise.withResolvers<unknown>()
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedBatch': lockedBatch.promise,
      'database.cancel': { cancelled: true },
      'database.rollbackTransaction': { rolledBack: true },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())
    const controller = new AbortController()

    const tx = await connection.transaction()
    await tx.query('SELECT 0')
    tx.defer?.({ text: 'SAVEPOINT a' })
    const query = tx.query('SELECT 1', { signal: controller.signal })
    controller.abort()
    await expect(query).rejects.toMatchObject({ name: 'AbortError' })
    lockedBatch.resolve({ rowCount: 0, rows: [] })

    // The Database application may or may not have run SAVEPOINT a.
    await expect(tx.query('SELECT 2')).rejects.toThrow('deferred statements may not have run')
    await expect(tx.commit()).rejects.toThrow('deferred statements may not have run')
    await tx.rollback()

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.lockedBatch',
      'database.cancel',
      'database.rollbackTransaction',
    ])
  })

  it('drops deferred statements that went with a query PostgreSQL failed', async () => {
    installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedBatch': {
        code: 'POSTGRES_ERROR',
        message: 'new row violates row-level security policy',
        sqlState: '42501',
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction()
    await tx.query('SELECT 0')
    tx.defer?.({ text: 'SAVEPOINT a' })
    await expect(tx.query('INSERT 1')).rejects.toMatchObject({ code: '42501' })

    // SAVEPOINT a ran before the INSERT failed: the next query goes without it.
    const { sent } = installWattMessagingMock({
      'database.lockedBatch': { rowCount: 0, rows: [] },
    })
    tx.defer?.({ text: 'ROLLBACK TO SAVEPOINT a' })
    await tx.query('SELECT 2')

    expect(sent[0].data.statements).toEqual([
      { sql: 'ROLLBACK TO SAVEPOINT a', values: undefined },
      { sql: 'SELECT 2', values: undefined },
    ])
  })

  it('runs a batch of queries in the message that opens the transaction', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': {
        lockId: 'lock-a',
        rowCount: 1,
        rows: [['3']],
        fields: [{ name: 'n', dataTypeID: 23 }],
        results: [
          { rowCount: 1, rows: [['1']], fields: [{ name: 'n', dataTypeID: 23 }] },
          { rowCount: 1, rows: [['2']], fields: [{ name: 'n', dataTypeID: 23 }] },
        ],
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction()
    await connection.setScope(tx)
    const results = await tx.queryBatch?.([
      { text: 'SELECT 1 AS n' },
      { text: 'SELECT 2 AS n' },
      { text: 'SELECT 3 AS n' },
    ])

    expect(results?.map((result) => result.rows[0].n)).toEqual([1, 2, 3])
    expect(sent).toHaveLength(1)
    const statements = sent[0].data.statements as Array<{ sql: string; result?: boolean }>
    // The scope (with the transaction's settings folded in), then the queries.
    expect(statements.map((statement) => statement.result)).toEqual([
      undefined,
      true,
      true,
      undefined,
    ])
    expect(statements[0].sql).toContain("set_config('role', $1, true)")
  })

  it('runs a permission probe as one batch that rolls back', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { rowCount: 1, rows: [] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    await connection.rollbackStatementExecutor?.().query('INSERT INTO t VALUES (1)')

    expect(sent).toHaveLength(1)
    expect(sent[0].data).toMatchObject({ commit: false, rollback: true })
    expect((sent[0].data.statements as Array<{ sql: string }>).at(-1)?.sql).toBe(
      'INSERT INTO t VALUES (1)'
    )
  })

  it('opens the transaction only once for concurrent first queries', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedQuery': { rowCount: 0, rows: [] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction()
    await Promise.all([tx.query('SELECT 1'), tx.query('SELECT 2')])

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.lockedQuery',
    ])
    expect(sent[1].data).toMatchObject({ lockId: 'lock-a', sql: 'SELECT 2' })
  })

  it('sends unknown isolation levels as a plain BEGIN like the direct path', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.beginTransaction({ isolation: 'read uncommitted' })
    await tx.query('SELECT 1')

    expect(sent[0].data.isolationLevel).toBeUndefined()
  })

  it('splits the tenant connection budget across the cluster', async () => {
    const { sent } = installWattMessagingMock({
      'database.query': { rowCount: 0, rows: [] },
    })
    const connection = await getWattPostgresConnection({
      ...createConnectionOptions(),
      clusterSize: 3,
      maxConnections: 10,
    })

    await connection.query('SELECT 1')

    expect(sent[0].data.destination).toMatchObject({ maxConnections: 4 })
  })

  it('rolls back transactions through Database Watt messaging', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.rollbackTransaction': { rolledBack: true },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const tx = await connection.transaction()
    await tx.query('SELECT 1')
    await tx.rollback()

    expect(sent.map((message) => message.message)).toEqual([
      'database.batch',
      'database.rollbackTransaction',
    ])
    expect(tx.isCompleted()).toBe(true)
  })

  it('asks the Database application to hold open a transaction opened with holdOpen', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 1, rows: [{ locked: true }] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const held = await connection.transaction({ holdOpen: true })
    await held.query('SELECT pg_try_advisory_xact_lock(1)')
    const plain = await connection.transaction()
    await plain.query('SELECT 1')

    expect(sent[0].data).toMatchObject({ commit: false, holdOpen: true })
    expect(sent[1].data.holdOpen).toBeUndefined()
  })

  it('sends nothing for a transaction that never ran a query', async () => {
    const { sent } = installWattMessagingMock()
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const committed = await connection.transaction()
    await connection.setScope(committed)
    await committed.commit()
    const rolledBack = await connection.transaction()
    await rolledBack.rollback()

    expect(sent).toHaveLength(0)
    expect(committed.isCompleted()).toBe(true)
    expect(rolledBack.isCompleted()).toBe(true)
  })

  it('completes a transaction whose first batch failed', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': {
        code: 'POSTGRES_ERROR',
        message: 'permission denied for table objects',
        sqlState: '42501',
        connectionDiscarded: true,
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())
    const tx = await connection.transaction()

    await expect(tx.query('SELECT 1')).rejects.toMatchObject({ code: '42501' })
    expect(tx.isCompleted()).toBe(true)
    await tx.rollback()
    expect(sent.map((message) => message.message)).toEqual(['database.batch'])
  })

  it('runs a single statement as one batch message that commits', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { rowCount: 1, rows: [{ id: 1 }] },
    })
    const connection = await getWattPostgresConnection({
      ...createConnectionOptions(),
      isExternalPool: true,
    })

    const executor = connection.singleStatementExecutor?.() as DatabaseExecutor
    const result = await executor.query({ text: 'SELECT $1::int AS id', values: [1] })

    expect(result.rows).toEqual([{ id: 1 }])
    expect(sent.map((message) => message.message)).toEqual(['database.batch'])
    expect(sent[0].data).toMatchObject({ destination: { isExternalPool: true }, commit: true })
    const statements = sent[0].data.statements as Array<{ sql: string; values?: unknown[] }>
    expect(statements).toHaveLength(2)
    expect(statements[0].sql).toContain("set_config('role', $1, true)")
    expect(statements[0].sql).toContain("set_config('search_path'")
    expect(statements[1]).toEqual({ sql: 'SELECT $1::int AS id', values: [1] })

    await expect(executor.query('SELECT 2')).rejects.toThrow(
      'A single statement executor runs only one statement'
    )
  })

  it('runs scoped statements as one batch message and returns every result', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': {
        rowCount: 1,
        fields: [{ name: 'name', dataTypeID: 25 }],
        rows: [['object-a']],
        results: [{ rowCount: 1, fields: [{ name: 'id', dataTypeID: 25 }], rows: [['bucket-a']] }],
      },
    })
    const connection = await getWattPostgresConnection({
      ...createConnectionOptions(),
      isExternalPool: true,
    })

    const results = await connection.scopedBatch?.([
      { text: 'SELECT id FROM storage.buckets', values: ['bucket-a'], asSuperUser: true },
      { text: 'SELECT name FROM storage.objects', values: ['object-a'] },
    ])

    expect(results?.map((result) => result.rows)).toEqual([
      [{ id: 'bucket-a' }],
      [{ name: 'object-a' }],
    ])
    expect(sent.map((message) => message.message)).toEqual(['database.batch'])
    expect(sent[0].data).toMatchObject({ commit: true, destination: { isExternalPool: true } })
    const statements = sent[0].data.statements as Array<{
      sql: string
      values: unknown[]
      result?: boolean
    }>
    expect(statements).toHaveLength(4)
    // The super user's scope, with the transaction-wide settings.
    expect(statements[0].values.slice(0, 3)).toEqual([
      'service_role',
      'service_role',
      'service-jwt',
    ])
    expect(statements[0].sql).toContain("set_config('statement_timeout'")
    expect(statements[0].sql).toContain("set_config('search_path'")
    expect(statements[1]).toEqual({
      sql: 'SELECT id FROM storage.buckets',
      values: ['bucket-a'],
      result: true,
    })
    // The caller's scope replaces it, and the settings are not sent twice.
    expect(statements[2].values.slice(0, 3)).toEqual(['authenticated', 'authenticated', 'user-jwt'])
    expect(statements[2].sql).not.toContain('statement_timeout')
    expect(statements[2].sql).not.toContain('search_path')
    // The last result is the response itself.
    expect(statements[3]).toStrictEqual({
      sql: 'SELECT name FROM storage.objects',
      values: ['object-a'],
    })
  })

  it('sends one scope for consecutive scoped statements with the same scope', async () => {
    const { sent } = installWattMessagingMock({
      'database.batch': { rowCount: 0, rows: [], results: [{ rowCount: 0, rows: [] }] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const results = await connection.scopedBatch?.([
      { text: 'SELECT 1', asSuperUser: true },
      { text: 'SELECT 2', asSuperUser: true },
    ])

    expect(results).toHaveLength(2)
    const statements = sent[0].data.statements as Array<{ sql: string; values?: unknown[] }>
    expect(statements).toHaveLength(3)
    expect(statements[0].sql).toContain("set_config('role', $1, true)")
    expect(statements[0].values?.[0]).toBe('service_role')
    expect(statements.slice(1).map((statement) => statement.sql)).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('parses raw rows with the pg type parsers', async () => {
    installWattMessagingMock({
      'database.query': {
        rowCount: 2,
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'size', dataTypeID: 20 },
          { name: 'created_at', dataTypeID: 1184 },
          { name: 'metadata', dataTypeID: 3802 },
          { name: 'path_tokens', dataTypeID: 1009 },
          { name: 'is_versioned', dataTypeID: 16 },
        ],
        rows: [
          ['1', '1024', '2026-11-20 15:08:00.123+00', '{"eTag":"abc"}', '{a,b}', 't'],
          [null, null, null, null, null, null],
        ],
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const result = await connection.query('SELECT 1')

    expect(result.rowCount).toBe(2)
    expect(result.fields.map((field) => field.name)).toEqual([
      'id',
      'size',
      'created_at',
      'metadata',
      'path_tokens',
      'is_versioned',
    ])
    expect(result.rows).toEqual([
      {
        id: 1,
        size: 1024,
        created_at: new Date('2026-11-20T15:08:00.123Z'),
        metadata: { eTag: 'abc' },
        path_tokens: ['a', 'b'],
        is_versioned: true,
      },
      {
        id: null,
        size: null,
        created_at: null,
        metadata: null,
        path_tokens: null,
        is_versioned: null,
      },
    ])
  })

  it('maps PostgreSQL error responses back to pg DatabaseError', async () => {
    installWattMessagingMock({
      'database.query': {
        code: 'POSTGRES_ERROR',
        message: 'duplicate key value violates unique constraint',
        sqlState: '23505',
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    await expect(connection.query('INSERT')).rejects.toMatchObject({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    })
  })

  it('restores PostgreSQL error fields used by Storage error mapping', async () => {
    installWattMessagingMock({
      'database.query': {
        code: 'POSTGRES_ERROR',
        message: 'update or delete violates foreign key constraint',
        sqlState: '23503',
        postgres: {
          constraint: 's3_multipart_uploads_bucket_id_fkey',
          detail: 'Key (id)=(bucket) is still referenced from table "s3_multipart_uploads".',
        },
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const error = await connection.query('DELETE').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error).toMatchObject({
      code: '23503',
      constraint: 's3_multipart_uploads_bucket_id_fkey',
      detail: 'Key (id)=(bucket) is still referenced from table "s3_multipart_uploads".',
    })
  })

  it('completes a transaction whose connection the Database application discarded', async () => {
    installWattMessagingMock({
      'database.batch': { lockId: 'lock-a', rowCount: 0, rows: [] },
      'database.lockedQuery': {
        code: 'POSTGRES_ERROR',
        message: 'terminating connection due to administrator command',
        sqlState: '57P01',
        connectionDiscarded: true,
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())
    const tx = await connection.beginTransaction()

    await tx.query('SELECT 1')
    await expect(tx.query('SELECT 2')).rejects.toMatchObject({ code: '57P01' })
    expect(tx.isCompleted()).toBe(true)
  })

  it('maps Platformatic messaging timeouts to DatabaseTimeout and cancels the request', async () => {
    const sent: SentWattMessage[] = []
    updateGlobals({
      messaging: {
        handle: vi.fn(),
        notify: vi.fn(),
        getWorkers: vi.fn(),
        getWorkerForAffinity: vi.fn(),
        onWorkersChange: vi.fn(),
        send: vi.fn(async (application: string, message: string, data: Record<string, unknown>) => {
          sent.push({ application, data, message })
          if (message === 'database.cancel') {
            return { cancelled: true }
          }
          const error = new Error(
            'Cannot send a message to application "database": Timeout while waiting for a response.'
          ) as Error & { code: string }
          error.code = 'PLT_RUNTIME_MESSAGING_ERROR'
          throw error
        }),
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    await expect(connection.query('SELECT pg_sleep(60)')).rejects.toMatchObject({
      code: 'DatabaseTimeout',
      httpStatusCode: 544,
    })
    expect(sent.map((message) => message.message)).toEqual(['database.query', 'database.cancel'])
    expect(sent[1].data.requestId).toBe(sent[0].data.requestId)
  })

  it('maps BUSY to a DatabaseBusy refusal the client can retry, keeping the reason', async () => {
    installWattMessagingMock({
      'database.query': {
        code: 'BUSY',
        message: 'Global acquisition queue is full',
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    const error = (await connection.query('SELECT 1').catch((e: unknown) => e)) as {
      getOriginalError(): unknown
    }

    expect(error).toMatchObject({
      code: 'DatabaseBusy',
      httpStatusCode: 429,
      userStatusCode: 429,
    })
    expect(error.getOriginalError()).toMatchObject({
      code: 'BUSY',
      message: 'Global acquisition queue is full',
    })
  })

  it.each(['ACQUIRE_TIMEOUT', 'CONNECTION_TIMEOUT'])(
    'maps %s to the DatabaseTimeout error a direct pool returns',
    async (code) => {
      installWattMessagingMock({
        'database.query': {
          code,
          message: 'Timed out acquiring database connection',
        },
      })
      const connection = await getWattPostgresConnection(createConnectionOptions())

      const error = (await connection.query('SELECT 1').catch((e: unknown) => e)) as {
        getOriginalError(): unknown
      }

      expect(error).toMatchObject({ code: 'DatabaseTimeout', httpStatusCode: 544 })
      expect(error.getOriginalError()).toMatchObject({ code })
    }
  )

  it('maps server timeouts to PostgreSQL query-canceled SQLSTATE', async () => {
    installWattMessagingMock({
      'database.query': {
        code: 'SERVER_TIMEOUT',
        message: 'canceling statement due to statement timeout',
      },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    await expect(connection.query('SELECT pg_sleep(10)')).rejects.toMatchObject({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
  })

  it('sends explicit cancellation when an AbortSignal fires', async () => {
    let resolveQuery!: (value: unknown) => void
    const { sent } = installWattMessagingMock({
      'database.query': new Promise((resolve) => {
        resolveQuery = resolve
      }),
      'database.cancel': { cancelled: true },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())
    const controller = new AbortController()

    const query = connection.query('SELECT pg_sleep(10)', { signal: controller.signal })
    controller.abort()

    await expect(query).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    resolveQuery({ rowCount: 0, rows: [] })

    expect(sent.map((message) => message.message)).toEqual(['database.query', 'database.cancel'])
    expect(sent[1].data.requestId).toBe(sent[0].data.requestId)
  })

  it('creates superuser connections with service role credentials', async () => {
    const { sent } = installWattMessagingMock({
      'database.query': { rowCount: 1, rows: [] },
    })
    const connection = await getWattPostgresConnection(createConnectionOptions())

    await connection.asSuperUser().query('SELECT 1')

    expect(sent[0].data.destination).toEqual(createPoolTarget())
    expect(connection.asSuperUser().role).toBe('service_role')
  })

  it('uses the shared PostgreSQL scope statement', async () => {
    const connection = await getWattPostgresConnection({
      ...createConnectionOptions(),
      headers: { 'x-client-info': 'test' },
      method: 'POST',
      path: '/object/bucket/name',
    })
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] })

    await connection.setScope({ query } as unknown as DatabaseExecutor)

    expect(query).toHaveBeenCalledTimes(1)
    const statement = query.mock.calls[0][0]
    expect(statement.text).toContain("set_config('role', $1, true)")
    // Direct (non-pooler) destinations get search_path as a connection option.
    expect(statement.text).not.toContain('search_path')
    expect(statement.values).toEqual([
      'authenticated',
      'authenticated',
      'user-jwt',
      '',
      '{"role":"authenticated"}',
      '{"x-client-info":"test"}',
      'POST',
      '/object/bucket/name',
      'operation-a',
    ])
  })
})

function createConnectionOptions(): TenantConnectionOptions {
  return {
    dbUrl: 'postgres://tenant-db',
    isExternalPool: false,
    maxConnections: 10,
    operation: () => 'operation-a',
    superUser: {
      jwt: 'service-jwt',
      payload: { role: 'service_role' },
    },
    tenantId: 'tenant-a',
    user: {
      jwt: 'user-jwt',
      payload: { role: 'authenticated' },
    },
  }
}

function createPoolTarget() {
  return {
    connectionString: 'postgres://tenant-db',
    id: 'tenant-a',
    isExternalPool: false,
    maxConnections: 10,
  }
}
