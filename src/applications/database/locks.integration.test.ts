import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { LockRegistry } from './locks.js'
import type { DatabasePoolTarget } from './protocol.js'

// COMMIT with deferred statements, against a real server: on a pipelining connection COMMIT
// is written behind them and PostgreSQL turns it into a ROLLBACK after a failure; otherwise
// the statements run first and COMMIT is never sent.
describe.each([
  ['a pipelining', true],
  ['a regular', false],
])('LockRegistry commit on %s connection', (_, pipeline) => {
  const table = 'database_watt_lock_commit_check'
  const config = getConfig()
  const destination: DatabasePoolTarget = {
    connectionString: config.databaseURL,
    id: 'lock-commit-check',
    isExternalPool: false,
    maxConnections: 2,
  }
  const owner = {}
  let pool: Pool
  let registry: LockRegistry

  async function count(): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
    return rows[0].n
  }

  async function lockWithInsert(): Promise<string> {
    const client = await pool.connect()
    await client.query('BEGIN')
    await client.query(`INSERT INTO ${table} VALUES (1)`)
    return registry.create(destination, client, true, owner)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: config.databaseURL, max: 2, pipeline })
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (n int)`)
    registry = new LockRegistry(config)
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${table}`)
  })

  afterAll(async () => {
    await registry.close()
    await pool.query(`DROP TABLE IF EXISTS ${table}`)
    await pool.end()
  })

  it('commits after the deferred statements', async () => {
    const lockId = await lockWithInsert()

    await registry.commit(lockId, owner, [
      { sql: 'SAVEPOINT a' },
      { sql: `INSERT INTO ${table} VALUES (2)` },
      { sql: 'RELEASE SAVEPOINT a' },
    ])

    expect(await count()).toBe(2)
    expect(registry.has(lockId)).toBe(false)
  })

  it('reports a failed deferred statement and commits nothing', async () => {
    const lockId = await lockWithInsert()

    await expect(
      registry.commit(lockId, owner, [
        { sql: 'RELEASE SAVEPOINT missing' },
        { sql: `INSERT INTO ${table} VALUES (2)` },
      ])
    ).rejects.toMatchObject({ code: '3B001' })

    // The connection is discarded, not handed out again.
    expect(pool.idleCount).toBe(0)
    expect(registry.has(lockId)).toBe(false)
    expect(await count()).toBe(0)
  })
})
