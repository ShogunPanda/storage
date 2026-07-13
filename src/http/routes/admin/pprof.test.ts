import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  heapSnapshot: vi.fn(),
  list: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@internal/monitoring/pprof/controller', () => ({
  ProfilingBusyError: class ProfilingBusyError extends Error {},
  profileController: {
    capture: mocks.capture,
    heapSnapshot: mocks.heapSnapshot,
    isActive: () => false,
  },
}))
vi.mock('@internal/monitoring/pprof/store', () => ({
  InvalidProfileCursorError: class InvalidProfileCursorError extends Error {},
  ProfileNotFoundError: class ProfileNotFoundError extends Error {},
  closeProfileStore: vi.fn(),
  getProfileStore: () => ({ list: mocks.list, head: mocks.head, get: mocks.get }),
}))
vi.mock('../../../config', () => ({
  getConfig: () => ({ adminApiKeys: 'secret', profilingS3Bucket: 'profiles' }),
}))

import { ProfileNotFoundError } from '@internal/monitoring/pprof/store'
import { signals } from '../../plugins/signals'
import routes from './pprof'

type CaptureHandler = (
  request: { query: { seconds?: number }; signals: { disconnect: AbortController } },
  reply: { hijack(): void }
) => Promise<unknown>

async function app(onCaptureHandler?: (handler: CaptureHandler) => void) {
  const fastify = Fastify()
  if (onCaptureHandler) {
    fastify.addHook('onRoute', (options) => {
      if (options.method === 'GET' && options.url.endsWith('/profile')) {
        onCaptureHandler(options.handler as unknown as CaptureHandler)
      }
    })
  }
  await fastify.register(signals)
  await fastify.register(routes, { prefix: '/debug/pprof' })
  return fastify
}

describe('admin pprof routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captures a local manual cpu profile for 30 seconds by default', async () => {
    mocks.capture.mockResolvedValue({ body: Buffer.from('profile') })
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profile',
      headers: { apikey: 'secret' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('profile')
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ class: 'manual', kind: 'cpu', reason: 'admin', seconds: 30 })
    )
    await fastify.close()
  })

  it('aborts an in-flight capture when the admin app closes', async () => {
    mocks.capture.mockImplementation((options: { signal: AbortSignal }) => {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        })
      })
    })
    const fastify = await app()
    const responsePromise = fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profile',
      headers: { apikey: 'secret' },
    })
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce())

    const closePromise = fastify.close()
    const response = await responsePromise

    expect(response.statusCode).toBe(503)
    expect((mocks.capture.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true)
    await closePromise
  })

  it('does not report a client-disconnect abort as a server error', async () => {
    const disconnect = new AbortController()
    mocks.capture.mockImplementation(async () => {
      disconnect.abort()
      throw disconnect.signal.reason
    })
    let handler: CaptureHandler | undefined
    const fastify = await app((registeredHandler) => {
      handler = registeredHandler
    })
    const reply = { hijack: vi.fn() }

    try {
      await handler!({ query: {}, signals: { disconnect } }, reply)

      expect(reply.hijack).toHaveBeenCalledOnce()
    } finally {
      await fastify.close()
    }
  })

  it('lists stored auto and manual profiles', async () => {
    mocks.list.mockResolvedValue({ profiles: [], cursor: 'next' })
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles?class=auto&kind=cpu&date=2026-07-13&limit=20',
      headers: { apikey: 'secret' },
    })

    expect(response.json()).toEqual({ profiles: [], cursor: 'next' })
    expect(mocks.list).toHaveBeenCalledWith({
      class: 'auto',
      kind: 'cpu',
      date: '2026-07-13',
      limit: 20,
    })
    await fastify.close()
  })

  it('rejects the old automatic class name', async () => {
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles?class=automatic',
      headers: { apikey: 'secret' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
    await fastify.close()
  })

  it('rejects invalid profile dates', async () => {
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles?class=auto&date=2026-02-30',
      headers: { apikey: 'secret' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
    await fastify.close()
  })

  it('rejects malformed profile cursors', async () => {
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles?class=auto&cursor=not%2Ba%2Bcursor',
      headers: { apikey: 'secret' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
    await fastify.close()
  })

  it('reads and downloads profiles using query-string ids', async () => {
    mocks.head.mockResolvedValue({ id: 'abc', kind: 'cpu' })
    mocks.get.mockResolvedValue({
      object: { ContentType: 'application/gzip', Body: Buffer.from('stored') },
      profile: {
        class: 'auto',
        service: 'api',
        kind: 'cpu',
        startedAt: new Date('2026-07-13T12:00:00.000Z'),
      },
    })
    const fastify = await app()

    const detail = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/detail?id=abc',
      headers: { apikey: 'secret' },
    })
    const download = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/download?id=abc',
      headers: { apikey: 'secret' },
    })

    expect(detail.json()).toEqual({ id: 'abc', kind: 'cpu' })
    expect(download.body).toBe('stored')
    expect(mocks.head).toHaveBeenCalledWith('abc')
    expect(mocks.get).toHaveBeenCalledWith('abc')
    await fastify.close()
  })

  it('returns 404 only when the stored profile is missing', async () => {
    mocks.head.mockRejectedValue(new ProfileNotFoundError('Profile not found'))
    mocks.get.mockRejectedValue(new ProfileNotFoundError('Profile not found'))
    const fastify = await app()

    const detail = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/detail?id=abc',
      headers: { apikey: 'secret' },
    })
    const download = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/download?id=abc',
      headers: { apikey: 'secret' },
    })

    expect(detail.statusCode).toBe(404)
    expect(download.statusCode).toBe(404)
    await fastify.close()
  })

  it('reports operational S3 failures as server errors', async () => {
    mocks.head.mockRejectedValue(new Error('S3 unavailable'))
    mocks.get.mockRejectedValue(new Error('S3 unavailable'))
    const fastify = await app()

    const detail = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/detail?id=abc',
      headers: { apikey: 'secret' },
    })
    const download = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/download?id=abc',
      headers: { apikey: 'secret' },
    })

    expect(detail.statusCode).toBe(500)
    expect(download.statusCode).toBe(500)
    await fastify.close()
  })

  it('requires an id query parameter for profile detail', async () => {
    const fastify = await app()
    const response = await fastify.inject({
      method: 'GET',
      url: '/debug/pprof/profiles/detail',
      headers: { apikey: 'secret' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.head).not.toHaveBeenCalled()
    await fastify.close()
  })

  it('protects profiling routes with the admin API key', async () => {
    const fastify = await app()
    const response = await fastify.inject({ method: 'GET', url: '/debug/pprof/profiles' })
    expect(response.statusCode).toBe(401)
    await fastify.close()
  })
})
