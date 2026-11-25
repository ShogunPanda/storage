import { afterEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => {
  type PendingConnect = {
    resolve: (client: unknown) => void
    reject: (error: unknown) => void
  }

  const state = {
    pending: [] as PendingConnect[],
    pools: [] as Array<{
      options: Record<string, unknown>
      totalCount: number
      idleCount: number
      waitingCount: number
      ended: boolean
    }>,
  }

  class Pool {
    totalCount = 0
    idleCount = 0
    waitingCount = 0
    ended = false
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

    async end() {
      this.ended = true
    }
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
import { PoolRegistry } from './pools.js'

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

  function target(id: string) {
    return {
      connectionString: `postgres://${id}-db`,
      id,
      isExternalPool: false,
      maxConnections: 1,
    }
  }

  function acquire(registry: PoolRegistry, id: string) {
    const acquiring = registry.acquire(target(id))
    acquiring.catch(() => undefined)
    return acquiring
  }

  it('evicts the least recently used idle pool when the registry is full', async () => {
    const registry = new PoolRegistry({ ...getConfig(), databaseWattMaxActivePools: 2 })
    void acquire(registry, 'tenant-a')
    void acquire(registry, 'tenant-b')
    // tenant-a is used again, so tenant-b is now the least recently used.
    void acquire(registry, 'tenant-a')

    void acquire(registry, 'tenant-c')

    expect(pgMock.state.pools.map((pool) => pool.ended)).toEqual([false, true, false])
    await registry.close()
  })

  it('skips pools that are in use when it evicts', async () => {
    const registry = new PoolRegistry({ ...getConfig(), databaseWattMaxActivePools: 3 })
    void acquire(registry, 'tenant-a')
    void acquire(registry, 'tenant-b')
    void acquire(registry, 'tenant-c')
    const [inUse, waitedOn] = pgMock.state.pools
    inUse.totalCount = 1
    waitedOn.waitingCount = 1

    void acquire(registry, 'tenant-d')

    expect(pgMock.state.pools.map((pool) => pool.ended)).toEqual([false, false, true, false])
    await registry.close()
  })

  it.each([
    ['a client is checked out', { totalCount: 1 }],
    ['a request is waiting', { waitingCount: 1 }],
  ])('rejects another destination when the registry is full and %s', async (_, busy) => {
    const registry = new PoolRegistry({ ...getConfig(), databaseWattMaxActivePools: 1 })
    void acquire(registry, 'tenant-a')
    Object.assign(pgMock.state.pools[0], busy)

    await expect(acquire(registry, 'tenant-b')).rejects.toMatchObject({
      code: 'BUSY',
      message: 'Maximum active destination pools reached',
    })
    expect(pgMock.state.pools).toHaveLength(1)
    expect(pgMock.state.pools[0].ended).toBe(false)
    await registry.close()
  })
})
