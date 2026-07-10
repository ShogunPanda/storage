import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildJobsCountRequest,
  buildJobsRequest,
  main,
  parseJobsOptions,
  resolveJobsAdminUrl,
} from './jobs-client'

describe('resolveJobsAdminUrl', () => {
  it('preserves base URL path prefixes and query params', () => {
    const url = resolveJobsAdminUrl('http://localhost:54321/admin/', '/queue/overflow', {
      source: 'backup',
      groupBy: 'tenant',
    })

    expect(url.toString()).toBe(
      'http://localhost:54321/admin/queue/overflow?source=backup&groupBy=tenant'
    )
  })
})

describe('parseJobsOptions', () => {
  it('uses defaults when optional env is omitted', () => {
    expect(parseJobsOptions({})).toEqual({
      confirmAll: undefined,
      queueName: undefined,
      eventTypes: undefined,
      tenantRefs: undefined,
      source: 'job',
      groupBy: 'summary',
      limit: undefined,
      maxPending: 50_000,
      sleepMs: 1_000,
    })
  })

  it('rejects invalid JOBS_SOURCE and JOBS_LIMIT values', () => {
    expect(
      parseJobsOptions({
        JOBS_SOURCE: 'archive',
      })
    ).toBe('JOBS_SOURCE must be either job or backup')

    expect(
      parseJobsOptions({
        JOBS_LIMIT: '0',
      })
    ).toBe('JOBS_LIMIT must be a positive integer')

    expect(
      parseJobsOptions({
        JOBS_BACKUP_CONFIRM_ALL: 'yes',
      })
    ).toBe('JOBS_BACKUP_CONFIRM_ALL must be either true or false')
  })

  it('parses backlog and sleep settings', () => {
    expect(
      parseJobsOptions({
        JOBS_MAX_PENDING: '12345',
        JOBS_SLEEP_MS: '25',
      })
    ).toMatchObject({ maxPending: 12_345, sleepMs: 25 })
  })

  it('rejects invalid backlog and sleep settings', () => {
    expect(
      parseJobsOptions({
        JOBS_MAX_PENDING: '0',
      })
    ).toBe('JOBS_MAX_PENDING must be a positive integer')

    expect(
      parseJobsOptions({
        JOBS_SLEEP_MS: 'later',
      })
    ).toBe('JOBS_SLEEP_MS must be a positive integer')
  })
})

describe('buildJobsRequest', () => {
  const baseConfig = {
    adminApiKey: 'test-key',
    adminUrl: 'http://localhost:54321/admin',
    confirmAll: undefined,
    queueName: 'webhooks',
    eventTypes: ['ObjectRemoved:Delete'],
    tenantRefs: ['tenant-a'],
    source: 'backup' as const,
    groupBy: 'tenant' as const,
    limit: 123,
    maxPending: 50_000,
    sleepMs: 1_000,
  }

  it('builds list requests with query params', () => {
    const request = buildJobsRequest('list', baseConfig)

    expect(request.method).toBe('GET')
    expect(request.body).toBeUndefined()
    expect(request.url.toString()).toBe(
      'http://localhost:54321/admin/queue/overflow?source=backup&groupBy=tenant&name=webhooks&eventTypes=ObjectRemoved%3ADelete&tenantRefs=tenant-a&limit=123'
    )
    expect((request.headers as Headers).get('ApiKey')).toBe('test-key')
  })

  it('builds the unfiltered live backlog count request', () => {
    const request = buildJobsCountRequest(baseConfig)

    expect(request.method).toBe('GET')
    expect(request.url.toString()).toBe('http://localhost:54321/admin/queue/overflow/count')
    expect(request.headers.get('ApiKey')).toBe('test-key')
  })

  it('builds backup requests with a JSON body', () => {
    const request = buildJobsRequest('backup', baseConfig)

    expect(request.method).toBe('POST')
    expect(request.url.toString()).toBe('http://localhost:54321/admin/queue/overflow/backup')
    expect(JSON.parse(request.body as string)).toEqual({
      name: 'webhooks',
      eventTypes: ['ObjectRemoved:Delete'],
      tenantRefs: ['tenant-a'],
      limit: 123,
    })
    expect((request.headers as Headers).get('ApiKey')).toBe('test-key')
    expect((request.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('rejects an unfiltered backup unless all jobs are explicitly confirmed', () => {
    const unfilteredConfig = {
      ...baseConfig,
      queueName: undefined,
      eventTypes: undefined,
      tenantRefs: undefined,
    }

    expect(() => buildJobsRequest('backup', unfilteredConfig)).toThrow(
      'Backup requires JOBS_QUEUE_NAME, JOBS_EVENT_TYPES, or JOBS_TENANT_REFS unless JOBS_BACKUP_CONFIRM_ALL=true'
    )

    const request = buildJobsRequest('backup', {
      ...unfilteredConfig,
      confirmAll: true,
    })
    expect(JSON.parse(request.body as string)).toEqual({
      confirmAll: true,
      limit: 123,
    })
  })

  it('builds a restore request with configured filters', () => {
    const request = buildJobsRequest('restore', baseConfig)

    expect(JSON.parse(request.body as string)).toEqual({
      name: 'webhooks',
      eventTypes: ['ObjectRemoved:Delete'],
      tenantRefs: ['tenant-a'],
      limit: 123,
    })
  })
})

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('sets a non-zero exit code for invalid actions', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main({}, ['node', 'jobs-client.ts', 'invalid'])).resolves.toBe(false)

    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Please provide an action: list, backup, or restore')
  })

  it.each([
    [{}, 'Please provide ADMIN_URL'],
    [{ ADMIN_URL: 'http://localhost:54321/admin' }, 'Please provide ADMIN_API_KEY'],
  ])('reports missing admin configuration', async (env, message) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main(env, ['node', 'jobs-client.ts', 'list'])).resolves.toBe(false)

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(message)
  })

  it('reports option validation errors without logging credentials', async () => {
    const adminApiKey = 'super-secret-admin-key'
    const fetchMock = vi.fn<typeof fetch>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: adminApiKey,
          JOBS_LIMIT: '0',
        },
        ['node', 'jobs-client.ts', 'list'],
        { fetch: fetchMock }
      )
    ).resolves.toBe(false)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('JOBS_LIMIT must be a positive integer')
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(adminApiKey)
  })

  it('refuses a bare backup before making a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
        },
        ['node', 'jobs-client.ts', 'backup']
      )
    ).resolves.toBe(false)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Backup requires JOBS_QUEUE_NAME, JOBS_EVENT_TYPES, or JOBS_TENANT_REFS unless JOBS_BACKUP_CONFIRM_ALL=true'
    )
  })

  it('prints the JSON response for successful single-shot requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ totalCount: 3 }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
          JOBS_QUEUE_NAME: 'webhooks',
        },
        ['node', 'jobs-client.ts', 'list']
      )
    ).resolves.toBe(true)

    expect(console.log).toHaveBeenCalledWith('{\n  "totalCount": 3\n}')
  })

  it('does not log authenticated response bodies', async () => {
    const adminApiKey = 'super-secret-admin-key'
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: `request failed for ${adminApiKey}` }), {
        status: 500,
        statusText: `Internal Server Error for ${adminApiKey}`,
      })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: adminApiKey,
          JOBS_QUEUE_NAME: 'webhooks',
        },
        ['node', 'jobs-client.ts', 'list'],
        { fetch: fetchMock }
      )
    ).resolves.toBe(false)

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('Jobs client request failed')
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(adminApiKey)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it.each([
    'error',
    'string',
  ] as const)('does not log %s fetch error details', async (rejectionType) => {
    const adminApiKey = 'super-secret-admin-key'
    const rejection =
      rejectionType === 'error'
        ? new Error(`request with ApiKey ${adminApiKey} failed`)
        : `request with ApiKey ${adminApiKey} failed`
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(rejection)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: adminApiKey,
          JOBS_QUEUE_NAME: 'webhooks',
        },
        ['node', 'jobs-client.ts', 'list'],
        { fetch: fetchMock }
      )
    ).resolves.toBe(false)

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('Jobs client request failed')
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(adminApiKey)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('waits while the global created backlog is above the threshold', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 61_234 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 55_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 50_000 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 3, conflictCount: 1, hasMore: false }), {
          status: 200,
        })
      )
    const sleep = vi.fn(async (_ms: number) => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
          JOBS_QUEUE_NAME: 'webhooks',
          JOBS_MAX_PENDING: '50000',
          JOBS_SLEEP_MS: '2',
        },
        ['node', 'jobs-client.ts', 'restore'],
        { fetch: fetchMock, sleep }
      )
    ).resolves.toBe(true)

    expect(sleep).toHaveBeenNthCalledWith(1, 2)
    expect(sleep).toHaveBeenNthCalledWith(2, 4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const call of fetchMock.mock.calls.slice(0, 3)) {
      expect(call[0].toString()).toBe('http://localhost:54321/admin/queue/overflow/count')
    }
    expect(console.error).toHaveBeenNthCalledWith(1, 'Queue backlog 61234 above 50000, waiting 2ms')
    expect(console.error).toHaveBeenNthCalledWith(2, 'Queue backlog 55000 above 50000, waiting 4ms')
  })

  it('caps backlog backoff and resets it after a successful batch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 60_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 60_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 50_000 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 1, conflictCount: 0, hasMore: true }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 60_000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 50_000 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 1, conflictCount: 0, hasMore: false }), {
          status: 200,
        })
      )
    const sleep = vi.fn(async (_ms: number) => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
          JOBS_SLEEP_MS: '40000',
        },
        ['node', 'jobs-client.ts', 'restore'],
        { fetch: fetchMock, sleep }
      )
    ).resolves.toBe(true)

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([40_000, 60_000, 40_000, 40_000])
    expect(console.error).toHaveBeenCalledWith('Queue backlog 60000 above 50000, waiting 60s')
    expect(console.error).toHaveBeenLastCalledWith('Restore batch 2: moved 1, conflicts 0')
  })

  it('drains restore batches and prints accumulated totals', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 12 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 2, conflictCount: 1, hasMore: true }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 15 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 3, conflictCount: 4, hasMore: false }), {
          status: 200,
        })
      )
    const sleep = vi.fn(async (_ms: number) => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
          JOBS_QUEUE_NAME: 'webhooks',
          JOBS_SLEEP_MS: '1',
        },
        ['node', 'jobs-client.ts', 'restore'],
        { fetch: fetchMock, sleep }
      )
    ).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith('Restore batch 1: moved 2, conflicts 1')
    expect(console.error).toHaveBeenCalledWith('Restore batch 2: moved 3, conflicts 4')
    expect(console.log).toHaveBeenCalledWith(
      '{\n  "batches": 2,\n  "conflictCount": 5,\n  "movedCount": 5\n}'
    )
  })

  it('aborts when restore reports more work without making progress', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 0 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ movedCount: 0, conflictCount: 0, hasMore: true }), {
          status: 200,
        })
      )
    const sleep = vi.fn(async (_ms: number) => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      main(
        {
          ADMIN_URL: 'http://localhost:54321/admin',
          ADMIN_API_KEY: 'test-key',
        },
        ['node', 'jobs-client.ts', 'restore'],
        { fetch: fetchMock, sleep }
      )
    ).resolves.toBe(false)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenLastCalledWith(
      'Restore reported hasMore=true without moving or dropping any rows'
    )
    expect(console.log).not.toHaveBeenCalled()
  })
})
