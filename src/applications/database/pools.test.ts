import { afterEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => {
  type PendingConnect = {
    resolve: (client: unknown) => void
    reject: (error: unknown) => void
  }

  const state = {
    pending: [] as PendingConnect[],
    pools: [] as Array<{ options: Record<string, unknown> }>,
  }

  class Pool {
    totalCount = 0
    idleCount = 0
    waitingCount = 0
    options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      state.pools.push(this)
    }

    on() {
      return this
    }

    connect() {
      return new Promise((resolve, reject) => {
        state.pending.push({ resolve, reject })
      })
    }

    async end() {}
  }

  return { Pool, state, types: { setTypeParser: () => undefined } }
})

vi.mock('pg', () => ({
  DatabaseError: class DatabaseError extends Error {},
  Pool: pgMock.Pool,
  types: pgMock.types,
  default: { types: pgMock.types },
}))

import { getConfig } from '../../config.js'
import type { BatchQuery } from './batch-query.js'
import { BeginError, PoolRegistry, runBatch, runStatements } from './pools.js'

function destination(id: string, maxConnections = 10) {
  return { connectionString: `postgres://${id}`, id, isExternalPool: false, maxConnections }
}

type MockPool = InstanceType<typeof pgMock.Pool>

afterEach(() => {
  pgMock.state.pending.length = 0
  pgMock.state.pools.length = 0
  vi.useRealTimers()
})

describe('database pool registry', () => {
  it('releases a client that is handed out after the acquire timeout fired', async () => {
    vi.useFakeTimers()
    const registry = new PoolRegistry({ ...getConfig(), databaseWattAcquireTimeout: 100 })

    const acquiring = registry.acquire({
      connectionString: 'postgres://tenant-db',
      id: 'tenant-a',
      isExternalPool: false,
      maxConnections: 1,
    })
    const rejection = expect(acquiring).rejects.toMatchObject({ code: 'ACQUIRE_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(100)
    await rejection

    const lateClient = { release: vi.fn() }
    pgMock.state.pending[0].resolve(lateClient)
    await vi.advanceTimersByTimeAsync(0)

    expect(lateClient.release).toHaveBeenCalledTimes(1)
    await registry.close()
  })

  it('stops waiting for a connection once the request is cancelled', async () => {
    const registry = new PoolRegistry(getConfig())
    const controller = new AbortController()

    const acquiring = registry.acquire(destination('tenant-a', 1), controller.signal)
    const rejection = expect(acquiring).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await rejection

    // The connection pg-pool hands out later goes straight back for the next request.
    const lateClient = { release: vi.fn() }
    pgMock.state.pending[0].resolve(lateClient)
    await new Promise((resolve) => setImmediate(resolve))

    expect(lateClient.release).toHaveBeenCalledTimes(1)
    await expect(
      registry.acquire(destination('tenant-a', 1), controller.signal)
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(pgMock.state.pending).toHaveLength(1)
    await registry.close()
  })

  it('does not let the pg-pool connect timeout cut the acquire wait short', async () => {
    const registry = new PoolRegistry({
      ...getConfig(),
      databaseConnectionTimeout: 3_000,
      databaseWattAcquireTimeout: 25_000,
    })

    void registry
      .acquire({
        connectionString: 'postgres://tenant-db',
        id: 'tenant-a',
        isExternalPool: false,
        maxConnections: 1,
      })
      .catch(() => undefined)

    expect(pgMock.state.pools[0].options.connectionTimeoutMillis).toBe(25_000)
    await registry.close()
  })

  it('closes the least recently used idle pool to make room at the active pool cap', async () => {
    const registry = new PoolRegistry({
      ...getConfig(),
      databaseWattGlobalMaxConnections: 0,
      databaseWattMaxActivePools: 2,
    })

    void registry.acquire(destination('tenant-a')).catch(() => undefined)
    void registry.acquire(destination('tenant-b')).catch(() => undefined)
    // tenant-a is used again, so tenant-b is now the least recently used.
    void registry.acquire(destination('tenant-a')).catch(() => undefined)

    const [, poolB] = pgMock.state.pools as MockPool[]
    const endB = vi.spyOn(poolB, 'end')

    void registry.acquire(destination('tenant-c')).catch(() => undefined)

    expect(endB).toHaveBeenCalledTimes(1)
    expect(registry.getStats().pools).toBe(2)
    await registry.close()
  })

  it('rejects a new destination at the active pool cap when every pool is in use', async () => {
    const registry = new PoolRegistry({
      ...getConfig(),
      databaseWattGlobalMaxConnections: 0,
      databaseWattMaxActivePools: 1,
    })

    void registry.acquire(destination('tenant-a')).catch(() => undefined)
    const [poolA] = pgMock.state.pools as MockPool[]
    poolA.totalCount = 1

    await expect(registry.acquire(destination('tenant-b'))).rejects.toMatchObject({
      code: 'BUSY',
      message: 'Maximum active destination pools reached',
    })
    await registry.close()
  })

  it.each([
    [0, 50],
    [20, 20],
  ])(
    'with DATABASE_WATT_DESTINATION_MAX_CONNECTIONS=%i sizes a 50-connection destination to %i',
    async (cap, expected) => {
      const registry = new PoolRegistry({
        ...getConfig(),
        databaseWattDestinationMaxConnections: cap,
        databaseWattGlobalMaxConnections: 0,
      })

      void registry.acquire(destination('tenant-a', 50)).catch(() => undefined)

      expect(pgMock.state.pools[0].options.max).toBe(expected)
      await registry.close()
    }
  )

  it('sets no worker-wide connection budget when DATABASE_WATT_GLOBAL_MAX_CONNECTIONS is 0', async () => {
    const budgeted = new PoolRegistry({ ...getConfig(), databaseWattGlobalMaxConnections: 5 })
    void budgeted.acquire(destination('tenant-a')).catch(() => undefined)
    ;(pgMock.state.pools[0] as MockPool).totalCount = 5

    await expect(budgeted.acquire(destination('tenant-b'))).rejects.toMatchObject({
      code: 'BUSY',
      message: 'Global connection budget is exhausted',
    })
    await budgeted.close()

    pgMock.state.pools.length = 0
    const unbudgeted = new PoolRegistry({ ...getConfig(), databaseWattGlobalMaxConnections: 0 })
    void unbudgeted.acquire(destination('tenant-a')).catch(() => undefined)
    ;(pgMock.state.pools[0] as MockPool).totalCount = 5

    void unbudgeted.acquire(destination('tenant-b')).catch(() => undefined)
    expect(pgMock.state.pools).toHaveLength(2)
    await unbudgeted.close()
  })
})

describe('runBatch', () => {
  type PlayedStatement = { text: string; reply: 'ok' | Error }

  // A client that answers a BatchQuery the way PostgreSQL does: in order, and nothing after
  // the first failure. `replies` decides each statement's outcome by its text.
  function client(replies: Record<string, Error> = {}) {
    const played: PlayedStatement[] = []
    const query = vi.fn((batch: BatchQuery) => {
      queueMicrotask(() => {
        for (const statement of batch.statements) {
          const failure = replies[statement.text]
          played.push({ text: statement.text, reply: failure ?? 'ok' })
          if (failure) {
            batch.handleError(failure)
            return
          }
          batch.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23 }] as never })
          batch.handleDataRow({ fields: ['1'] })
          batch.handleCommandComplete({ text: 'SELECT 1' })
        }
        batch.handleReadyForQuery()
      })
      return batch
    })
    return { client: { query } as never, query, played }
  }

  const row = {
    command: 'SELECT',
    rowCount: 1,
    rows: [['1']],
    fields: [{ name: 'n', dataTypeID: 23 }],
  }

  it('sends BEGIN, the statements and COMMIT as one query', async () => {
    const { client: pgClient, query } = client()

    const results = await runBatch(
      pgClient,
      'BEGIN',
      [{ sql: 'SELECT 1', values: [1] }, { sql: 'SELECT 2' }],
      'COMMIT'
    )

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0].statements).toEqual([
      { text: 'BEGIN' },
      { text: 'SELECT 1', values: [1] },
      { text: 'SELECT 2', values: undefined },
      { text: 'COMMIT' },
    ])
    // Only the statements' results: not BEGIN's, nor COMMIT's.
    expect(results).toMatchObject([row, row])
  })

  it('throws a BeginError when BEGIN fails, and nothing behind it runs', async () => {
    const refused = new Error('no more connections allowed')
    const { client: pgClient, played } = client({ BEGIN: refused })

    const failure = runBatch(pgClient, 'BEGIN', [{ sql: 'INSERT 1' }], 'COMMIT')

    await expect(failure).rejects.toBeInstanceOf(BeginError)
    await expect(failure).rejects.toMatchObject({ original: refused })
    expect(played).toEqual([{ text: 'BEGIN', reply: refused }])
  })

  it('throws the statement error itself once BEGIN has run', async () => {
    const missing = new Error('relation "missing" does not exist')
    const { client: pgClient, played } = client({ 'SELECT missing': missing })

    await expect(
      runBatch(pgClient, 'BEGIN', [{ sql: 'SELECT missing' }, { sql: 'SELECT 2' }], 'COMMIT')
    ).rejects.toBe(missing)
    expect(played.map((statement) => statement.text)).toEqual(['BEGIN', 'SELECT missing'])
  })

  it('throws statement errors as they are without BEGIN (a locked batch)', async () => {
    const missing = new Error('relation "missing" does not exist')
    const { client: pgClient } = client({ 'SELECT missing': missing })

    await expect(runStatements(pgClient, [{ sql: 'SELECT missing' }])).rejects.toBe(missing)
  })

  it('sends nothing once the request is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client: pgClient, query } = client()

    await expect(
      runBatch(pgClient, 'BEGIN', [{ sql: 'SELECT 1' }], 'COMMIT', controller.signal)
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(query).not.toHaveBeenCalled()
  })
})
