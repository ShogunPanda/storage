import pg, { type Connection, type FieldDef, type QueryResult } from 'pg'

export type RawRow = Array<string | null>

export type BatchQueryStatement = { text: string; values?: unknown[] }

// The parts of pg's connection a query writes to (its typings lag behind pg's methods).
type BatchQueryConnection = {
  stream: { cork(): void; uncork(): void }
  parse(query: { text: string }): void
  bind(config: { values: unknown[] }): void
  describe(config: { type: 'P'; name: string }): void
  execute(config: { portal: string; rows: number }): void
  flush(): void
  sync(): void
  sendCopyFail(message: string): void
}

type CommandCompleteMessage = { text: string }

const COMMAND_TAG = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/
const noValues: unknown[] = []

// pg's own parameter mapping (Buffers, Dates, arrays, JSON), as its Query applies it.
function prepareValue(value: unknown): unknown {
  return (pg as unknown as { utils: { prepareValue(value: unknown): unknown } }).utils.prepareValue(
    value
  )
}

/**
 * BEGIN (optional), statements and COMMIT or ROLLBACK (optional), written to PostgreSQL at
 * once and ended by a single Sync, as one pg query: one round trip.
 *
 * After an error PostgreSQL skips every message up to the Sync, so nothing behind a failed
 * statement runs, a failed BEGIN included. pg cannot do this with separate queries: each ends
 * with its own Sync, and statements behind a failed BEGIN would each run in autocommit.
 *
 * BEGIN is followed by a Flush, so its reply comes back as soon as it has run: if the query
 * fails before that reply (`beganTransaction` is false), BEGIN did not run and nothing behind it
 * did either.
 *
 * Rows come back as arrays of the text PostgreSQL sent, unparsed.
 */
export class BatchQuery {
  readonly statements: BatchQueryStatement[]
  readonly promise: Promise<QueryResult<RawRow>[]>
  #first: number
  #count: number
  #results: QueryResult<RawRow>[]
  #index = 0
  #settled = false
  #resolve!: (results: QueryResult<RawRow>[]) => void
  #reject!: (error: unknown) => void

  constructor(statements: BatchQueryStatement[], begin?: string, end?: string) {
    this.statements = statements
    this.#first = begin ? 1 : 0
    this.#count = statements.length
    if (begin || end) {
      this.statements = [...statements]
      if (begin) this.statements.unshift({ text: begin })
      if (end) this.statements.push({ text: end })
    }

    this.#results = this.statements.map(() => ({
      command: '',
      rowCount: null,
      oid: 0,
      fields: [],
      rows: [],
    }))
    this.promise = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  // True once BEGIN has replied (or when there is no BEGIN).
  get beganTransaction(): boolean {
    return this.#index >= this.#first
  }

  // Like pg's Query, a value pg cannot send fails the query (the returned error) before
  // anything is written.
  submit(pgConnection: Connection): Error | undefined {
    const values = new Array<unknown[]>(this.statements.length)
    try {
      for (let i = 0; i < this.statements.length; i++) {
        values[i] = this.statements[i].values?.map(prepareValue) ?? noValues
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }

    const connection = pgConnection as unknown as BatchQueryConnection
    const stream = connection.stream
    stream.cork()
    try {
      for (let i = 0; i < this.statements.length; i++) {
        connection.parse({ text: this.statements[i].text })
        connection.bind({ values: values[i] })
        connection.describe({ type: 'P', name: '' })
        connection.execute({ portal: '', rows: 0 })
        if (i < this.#first) {
          connection.flush()
        }
      }
      connection.sync()
    } finally {
      stream.uncork()
    }
  }

  handleRowDescription(message: { fields: FieldDef[] }): void {
    this.#results[this.#index].fields = message.fields
  }

  handleDataRow(message: { fields: RawRow }): void {
    this.#results[this.#index].rows.push(message.fields)
  }

  handleCommandComplete(message: CommandCompleteMessage): void {
    const result = this.#results[this.#index++]
    const match = COMMAND_TAG.exec(message.text)
    if (match) {
      result.command = match[1]
      if (match[3]) {
        result.oid = Number.parseInt(match[2], 10)
        result.rowCount = Number.parseInt(match[3], 10)
      } else if (match[2]) {
        result.rowCount = Number.parseInt(match[2], 10)
      }
    }
  }

  handleEmptyQuery(): void {
    this.#index++
  }

  handlePortalSuspended(): void {}

  handleCopyInResponse(connection: Connection): void {
    ;(connection as unknown as BatchQueryConnection).sendCopyFail(
      'COPY is not supported in a batch'
    )
  }

  handleCopyData(): void {}

  // pg forgets the active query on an error, so ReadyForQuery never reaches this one then.
  handleError(error: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.#reject(error)
  }

  handleReadyForQuery(): void {
    if (this.#settled) return
    this.#settled = true
    this.#resolve(this.#results.slice(this.#first, this.#first + this.#count))
  }
}
