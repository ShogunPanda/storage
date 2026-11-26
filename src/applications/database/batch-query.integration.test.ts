import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { BeginError, runBatch, runStatements } from './pools.js'

// A batch is written at once and ends with a single Sync: PostgreSQL itself skips what
// follows a failure, so these run against a real server.
describe('Database application batches on PostgreSQL', () => {
  const table = 'database_watt_batch_query_check'
  let client: Client

  async function count(): Promise<number> {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`)
    return rows[0].n
  }

  beforeAll(async () => {
    client = new Client({ connectionString: getConfig().databaseURL })
    await client.connect()
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (n int)`)
  })

  beforeEach(async () => {
    await client.query(`TRUNCATE ${table}`)
  })

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS ${table}`)
    await client.end()
  })

  it('runs nothing behind a BEGIN that fails', async () => {
    const failure = runBatch(
      client as never,
      'BEGIN ISOLATION LEVEL NONE',
      [
        { sql: "SELECT set_config('request.jwt.claim.sub', 'someone', true)" },
        { sql: `INSERT INTO ${table} VALUES (1)` },
      ],
      'COMMIT'
    )

    await expect(failure).rejects.toBeInstanceOf(BeginError)
    await expect(failure).rejects.toMatchObject({ original: { code: '42601' } })
    expect(await count()).toBe(0)
  })

  it('skips the rest of the batch after a failure, COMMIT included', async () => {
    await expect(
      runBatch(
        client as never,
        'BEGIN',
        [
          { sql: `INSERT INTO ${table} VALUES (1)` },
          { sql: 'SELECT 1/0' },
          { sql: `INSERT INTO ${table} VALUES (2)` },
        ],
        'COMMIT'
      )
    ).rejects.toMatchObject({ code: '22012' })

    // The transaction is left aborted for the caller to roll back.
    await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
    await client.query('ROLLBACK')
    expect(await count()).toBe(0)
  })

  it('applies the scope to the statements behind it and returns raw rows', async () => {
    const [, scoped] = await runBatch(
      client as never,
      'BEGIN',
      [
        {
          sql: "SELECT set_config('role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)",
          values: ['user-1'],
        },
        { sql: "SELECT current_user, current_setting('request.jwt.claim.sub'), 2::int AS two" },
      ],
      'COMMIT'
    )

    expect(scoped.rows).toEqual([['authenticated', 'user-1', '2']])
    expect(scoped.fields.map((field) => field.name)).toEqual([
      'current_user',
      'current_setting',
      'two',
    ])
    // The scope ended with the transaction.
    const { rows } = await client.query(
      "SELECT current_user, current_setting('request.jwt.claim.sub', true) AS sub"
    )
    expect(rows[0].current_user).not.toBe('authenticated')
    expect(rows[0].sub || '').toBe('')
  })

  it('keeps a locked transaction open across batches until COMMIT', async () => {
    await client.query('BEGIN')
    await runStatements(client as never, [{ sql: `INSERT INTO ${table} VALUES (1)` }])
    await runStatements(client as never, [{ sql: `INSERT INTO ${table} VALUES (2)` }], {
      end: 'COMMIT',
    })

    expect(await count()).toBe(2)
  })

  it('reports row counts', async () => {
    const [inserted, updated] = await runBatch(
      client as never,
      'BEGIN',
      [
        { sql: `INSERT INTO ${table} SELECT generate_series(1, 3)` },
        { sql: `UPDATE ${table} SET n = n + 1 WHERE n > $1`, values: [1] },
      ],
      'COMMIT'
    )

    expect(inserted.rowCount).toBe(3)
    expect(updated.rowCount).toBe(2)
  })
})
