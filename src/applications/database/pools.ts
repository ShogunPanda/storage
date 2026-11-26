import {
  attachPoolErrorHandler,
  isConnectionStateError,
} from '@internal/database/postgres/pool-errors'
import { buildSearchPath } from '@internal/database/postgres/sql'
import { getSslSettings } from '@internal/database/postgres/ssl'
import { installPostgresTypeParsers } from '@internal/database/postgres/type-parsers'
import { getLogger } from '@platformatic/globals'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import type { StorageConfigType } from '../../config.js'
import { BatchQuery, type BatchQueryStatement, type RawRow } from './batch-query.js'
import { releaseErrorFor } from './cancellation.js'
import { busyError, cancelledError, DatabaseWattError } from './errors.js'
import type {
  BatchResponse,
  BatchStatement,
  DatabasePoolTarget,
  RawQueryResponse,
} from './protocol.js'

// pg type parsers are module-global and this application runs in its own worker
// thread, so they have to be installed here as well as in the storage workers.
// Statements run by runQuery skip them (rows go back unparsed); BEGIN, COMMIT and
// the other session statements still use them.
installPostgresTypeParsers()

export type { RawRow }

const passThrough = (value: string) => value

// Every column comes back as the text PostgreSQL sent: the storage worker parses it.
const rawTypes = {
  getTypeParser: () => passThrough,
}

type PoolEntry = {
  config: DatabasePoolTarget
  lastUsedAt: number
  pool: Pool
}

export type PoolRegistryStats = {
  pools: number
  totalConnections: number
  inUseConnections: number
  waitingRequests: number
}

export class PoolRegistry {
  private readonly config: StorageConfigType
  // In least recently used order: a pool moves to the end whenever it is used.
  private readonly pools = new Map<string, PoolEntry>()
  private readonly retiringPools = new Set<Promise<void>>()
  private readonly searchPath: string
  private pendingGlobalAcquisitions = 0
  private cachedStats?: PoolRegistryStats
  private readonly evictionInterval: NodeJS.Timeout

  constructor(config: StorageConfigType) {
    this.config = config
    this.searchPath = buildSearchPath(config.dbSearchPath).join(',')
    this.evictionInterval = setInterval(
      () => {
        void this.evictIdlePools()
      },
      Math.max(config.databaseWattPoolIdleTimeout, 1_000)
    )
    this.evictionInterval.unref()
  }

  /**
   * Runs one statement on a pooled connection. With `signal`, a cancelled request stops
   * waiting for a connection; `onClient` runs before the statement and can refuse to start
   * it by throwing.
   */
  async query(
    destination: DatabasePoolTarget,
    sql: string,
    values: unknown[] | undefined,
    options: { signal?: AbortSignal; onClient?: (client: PoolClient) => void } = {}
  ): Promise<RawQueryResponse> {
    const client = await this.acquire(destination, options.signal)
    let releaseError: Error | undefined

    try {
      options.onClient?.(client)
      const result = await runQuery(client, sql, values)
      return toQueryResponse(result)
    } catch (error) {
      if (isConnectionStateError(error)) {
        releaseError = error instanceof Error ? error : new Error(String(error))
      }
      throw error
    } finally {
      client.release(releaseErrorFor(client, releaseError))
    }
  }

  /** A connection for `destination`. Once `signal` is aborted, the wait for one stops. */
  async acquire(destination: DatabasePoolTarget, signal?: AbortSignal): Promise<PoolClient> {
    if (signal?.aborted) {
      throw cancelledError()
    }

    const entry = this.getOrCreatePool(destination)
    this.assertCanAcquire(entry)

    // An idle client is handed out without waiting, so there is nothing to time out.
    if (entry.pool.idleCount > entry.pool.waitingCount) {
      entry.lastUsedAt = Date.now()
      return entry.pool.connect()
    }

    this.pendingGlobalAcquisitions++
    entry.lastUsedAt = Date.now()

    const connecting = entry.pool.connect()
    let abandoned = false
    let timeout: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined

    try {
      return await new Promise<PoolClient>((resolve, reject) => {
        timeout = setTimeout(() => {
          abandoned = true
          reject(
            new DatabaseWattError('ACQUIRE_TIMEOUT', 'Timed out acquiring database connection')
          )
        }, this.config.databaseWattAcquireTimeout)
        timeout.unref()
        if (signal) {
          // The caller is gone: stop waiting rather than run its statements once a
          // connection frees up, ahead of requests that are still wanted.
          onAbort = () => {
            abandoned = true
            reject(cancelledError())
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        connecting.then(resolve, reject)
      })
    } finally {
      clearTimeout(timeout)
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort)
      }
      this.pendingGlobalAcquisitions--
      entry.lastUsedAt = Date.now()

      if (abandoned) {
        // pg-pool keeps the pending request queued after we stop waiting for it.
        // Hand a late client straight back so it does not leak out of the pool.
        connecting.then(
          (client) => client.release(),
          () => undefined
        )
      }
    }
  }

  getStats(): PoolRegistryStats {
    if (this.cachedStats) {
      return this.cachedStats
    }

    let inUseConnections = 0
    let totalConnections = 0
    let waitingRequests = 0

    for (const entry of this.pools.values()) {
      inUseConnections += Math.max(entry.pool.totalCount - entry.pool.idleCount, 0)
      totalConnections += entry.pool.totalCount
      waitingRequests += entry.pool.waitingCount
    }

    const stats = {
      inUseConnections,
      pools: this.pools.size,
      totalConnections,
      waitingRequests,
    }
    this.cachedStats = stats
    queueMicrotask(() => {
      this.cachedStats = undefined
    })

    return stats
  }

  async close(): Promise<void> {
    clearInterval(this.evictionInterval)
    const pools = [...this.pools.values()].map((entry) => entry.pool)
    this.pools.clear()
    this.cachedStats = undefined
    await Promise.allSettled([...pools.map((pool) => pool.end()), ...this.retiringPools])
  }

  private getOrCreatePool(destination: DatabasePoolTarget): PoolEntry {
    const existing = this.pools.get(destination.id)
    if (existing && hasSameConnectionTarget(existing.config, destination)) {
      if (existing.config.maxConnections !== destination.maxConnections) {
        this.resizePool(existing, destination)
      }
      existing.lastUsedAt = Date.now()
      // Map keeps insertion order: re-inserting keeps the least recently used first.
      this.pools.delete(destination.id)
      this.pools.set(destination.id, existing)
      return existing
    }

    if (!existing && this.pools.size >= this.config.databaseWattMaxActivePools) {
      // Like the direct path's tenant pool cache, make room by closing the least recently
      // used pool, as long as it has nothing checked out or waiting.
      if (!this.evictLeastRecentlyUsedIdlePool()) {
        throw busyError('max_active_pools', 'Maximum active destination pools reached')
      }
    }

    const pool = attachPoolErrorHandler(
      new Pool({
        application_name: this.config.databaseApplicationName,
        connectionString: destination.connectionString,
        // pg-pool applies this to queued checkouts as well as new connections, so it
        // must not undercut DATABASE_WATT_ACQUIRE_TIMEOUT, which bounds the wait.
        connectionTimeoutMillis: Math.max(
          this.config.databaseConnectionTimeout,
          this.config.databaseWattAcquireTimeout
        ),
        idleTimeoutMillis: this.config.databaseWattPoolIdleTimeout,
        max: this.getPoolMax(destination),
        min: 0,
        // Same session defaults as the direct tenant pools: external poolers get
        // search_path per transaction through the scope statement instead.
        options: destination.isExternalPool ? undefined : `-c search_path=${this.searchPath}`,
        // No pg pipelining: a batch is already one round trip (BatchQuery), and pg refuses
        // custom queries on a pipelining client.
        ssl: getSslSettings({
          connectionString: destination.connectionString,
          databaseSSLRootCert: this.config.databaseSSLRootCert,
        }),
      }),
      (error) => {
        getLogger({ throwOnMissing: false })?.warn(
          {
            err: error,
            type: 'db',
            tenantId: destination.id,
            project: destination.id,
          },
          '[DatabaseWatt] Idle destination pg client error'
        )
      }
    )

    const entry = {
      config: destination,
      lastUsedAt: Date.now(),
      pool,
    }

    if (existing) {
      this.retirePool(existing.pool)
    }

    this.pools.set(destination.id, entry)
    this.cachedStats = undefined
    return entry
  }

  // DATABASE_WATT_DESTINATION_MAX_CONNECTIONS = 0 adds no cap of its own: the
  // destination's share of the tenant's max_connections is the limit.
  private getPoolMax(destination: DatabasePoolTarget): number {
    const cap = this.config.databaseWattDestinationMaxConnections
    const max = cap > 0 ? Math.min(destination.maxConnections, cap) : destination.maxConnections
    return Math.max(max, 1)
  }

  private evictLeastRecentlyUsedIdlePool(): boolean {
    for (const [destination, entry] of this.pools) {
      if (entry.pool.totalCount === entry.pool.idleCount && entry.pool.waitingCount === 0) {
        this.pools.delete(destination)
        this.retirePool(entry.pool)
        return true
      }
    }
    return false
  }

  // Capacity changes (tenant max_connections or cluster size) resize the live pool
  // instead of replacing it, so in-flight clients and warm connections survive.
  private resizePool(entry: PoolEntry, destination: DatabasePoolTarget): void {
    const previousMax = entry.pool.options.max
    const nextMax = this.getPoolMax(destination)
    entry.config = destination

    if (previousMax === nextMax) {
      return
    }

    entry.pool.options.max = nextMax
    if (nextMax > previousMax) {
      ;(entry.pool as Pool & { _pulseQueue?: () => void })._pulseQueue?.()
    }
  }

  private assertCanAcquire(entry: PoolEntry): void {
    if (this.pendingGlobalAcquisitions >= this.config.databaseWattGlobalAcquireQueueLimit) {
      throw busyError('global_acquire_queue', 'Global acquisition queue is full')
    }

    const { pool } = entry
    if (pool.waitingCount >= this.config.databaseWattDestinationAcquireQueueLimit) {
      throw busyError('destination_acquire_queue', 'Destination acquisition queue is full')
    }

    // Only a request that makes pg-pool open a new connection spends global budget.
    // A request for a pool that is already at its own max waits in that pool's
    // queue (bounded above) for a connection to be released.
    const opensConnection = pool.idleCount === 0 && pool.totalCount < pool.options.max
    if (!opensConnection) {
      return
    }

    // DATABASE_WATT_GLOBAL_MAX_CONNECTIONS = 0 sets no budget for the worker as a whole.
    if (this.config.databaseWattGlobalMaxConnections === 0) {
      return
    }

    if (this.getStats().totalConnections < this.config.databaseWattGlobalMaxConnections) {
      return
    }

    if (this.reclaimIdlePools(entry) && this.hasGlobalConnectionBudget()) {
      return
    }

    throw busyError('global_connection_budget', 'Global connection budget is exhausted')
  }

  private hasGlobalConnectionBudget(): boolean {
    this.cachedStats = undefined
    return this.getStats().totalConnections < this.config.databaseWattGlobalMaxConnections
  }

  // Ends least recently used pools whose connections are all idle so another
  // destination can open one. Returns whether any pool was reclaimed.
  private reclaimIdlePools(target: PoolEntry): boolean {
    const candidates = [...this.pools.entries()]
      .filter(([, entry]) => {
        return (
          entry !== target &&
          entry.pool.totalCount > 0 &&
          entry.pool.totalCount === entry.pool.idleCount &&
          entry.pool.waitingCount === 0
        )
      })
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)

    let reclaimed = false
    for (const [destination, entry] of candidates) {
      this.pools.delete(destination)
      this.retirePool(entry.pool)
      reclaimed = true

      // pg-pool drops idle clients from totalCount synchronously on end().
      if (this.hasGlobalConnectionBudget()) {
        break
      }
    }

    return reclaimed
  }

  private async evictIdlePools(): Promise<void> {
    const now = Date.now()
    const toEvict: Pool[] = []

    for (const [destination, entry] of this.pools) {
      if (now - entry.lastUsedAt < this.config.databaseWattPoolIdleTimeout) {
        continue
      }

      if (entry.pool.totalCount !== entry.pool.idleCount || entry.pool.waitingCount > 0) {
        continue
      }

      this.pools.delete(destination)
      this.cachedStats = undefined
      toEvict.push(entry.pool)
    }

    await Promise.allSettled(toEvict.map((pool) => pool.end()))
  }

  private retirePool(pool: Pool): void {
    this.cachedStats = undefined
    const retirement = pool
      .end()
      .catch((error) => {
        getLogger({ throwOnMissing: false })?.warn(
          { err: error, type: 'db' },
          '[DatabaseWatt] Failed to retire replaced destination pool'
        )
      })
      .finally(() => {
        this.retiringPools.delete(retirement)
      })
    this.retiringPools.add(retirement)
  }
}

function hasSameConnectionTarget(left: DatabasePoolTarget, right: DatabasePoolTarget): boolean {
  return (
    left.connectionString === right.connectionString && left.isExternalPool === right.isExternalPool
  )
}

// Runs a statement on behalf of a storage worker. Rows come back as arrays of raw text
// values and the storage worker parses them, so this thread does not build row objects.
export async function runQuery(
  client: PoolClient,
  sql: string,
  values?: unknown[]
): Promise<QueryResult<RawRow>> {
  return client.query<RawRow>({ text: sql, values, rowMode: 'array', types: rawTypes })
}

export function toQueryResponse(result: QueryResult<RawRow>): RawQueryResponse {
  const fields = new Array(result.fields.length)
  for (let i = 0; i < result.fields.length; i++) {
    const field = result.fields[i]
    fields[i] = { name: field.name, dataTypeID: field.dataTypeID }
  }

  return {
    fields,
    rows: result.rows,
    rowCount: result.rowCount || 0,
  }
}

/**
 * The response to a batch: the last statement's result, plus the results of the
 * statements flagged with `result`, in order.
 */
export function toBatchResponse(
  statements: BatchStatement[],
  results: QueryResult<RawRow>[]
): BatchResponse {
  const response: BatchResponse = toQueryResponse(results[results.length - 1])
  for (let i = 0; i < statements.length; i++) {
    if (statements[i].result) {
      response.results ??= []
      response.results.push(toQueryResponse(results[i]))
    }
  }
  return response
}

export class BeginError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original })
    this.name = 'BeginError'
  }
}

export type BatchEnd = 'COMMIT' | 'ROLLBACK'

/**
 * Runs BEGIN, `statements` and, when asked, COMMIT or ROLLBACK on one connection, returning
 * the result of every statement, in order. A failed BEGIN is thrown as a BeginError so callers
 * can retry it on another connection: nothing behind it ran.
 */
export function runBatch(
  client: PoolClient,
  beginStatement: string,
  statements: BatchStatement[],
  end?: BatchEnd,
  signal?: AbortSignal
): Promise<QueryResult<RawRow>[]> {
  return runStatements(client, statements, { begin: beginStatement, end, signal })
}

/**
 * Runs `statements` on one connection, after `begin` and before `end` when they are given,
 * and returns the result of every statement, in order. Everything is written at once and
 * ends with a single Sync (see BatchQuery): one round trip, and after a failure PostgreSQL
 * runs nothing else, `end` included. A transaction that was open stays open, aborted, for
 * the caller to roll back. A failure before BEGIN replied is thrown as a BeginError.
 *
 * Once `signal` is aborted nothing is sent; past that point a cancel interrupts the
 * statement PostgreSQL is running.
 */
export async function runStatements(
  client: PoolClient,
  statements: BatchStatement[],
  { begin, end, signal }: { begin?: string; end?: BatchEnd; signal?: AbortSignal } = {}
): Promise<QueryResult<RawRow>[]> {
  throwIfCancelled(signal)

  const query = new BatchQuery(toBatchQueryStatements(statements), begin, end)
  client.query(query)

  try {
    return await query.promise
  } catch (error) {
    if (!query.beganTransaction) {
      throw new BeginError(error)
    }
    throw error
  }
}

function toBatchQueryStatements(statements: BatchStatement[]): BatchQueryStatement[] {
  const result = new Array<BatchQueryStatement>(statements.length)
  for (let i = 0; i < statements.length; i++) {
    result[i] = { text: statements[i].sql, values: statements[i].values }
  }
  return result
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancelledError()
  }
}
