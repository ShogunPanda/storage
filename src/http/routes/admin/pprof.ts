import { ProfilingBusyError, profileController } from '@internal/monitoring/pprof/controller'
import {
  closeProfileStore,
  getProfileStore,
  InvalidProfileCursorError,
  ProfileNotFoundError,
} from '@internal/monitoring/pprof/store'
import type { ProfileClass, ProfileKind } from '@internal/monitoring/pprof/types'
import type { FastifyInstance } from 'fastify'
import { getConfig } from '../../../config'
import { registerApiKeyAuth } from '../../plugins/apikey'

const { profilingS3Bucket } = getConfig()

const captureQuery = {
  type: 'object',
  properties: { seconds: { type: 'integer', minimum: 1, maximum: 300, default: 30 } },
  additionalProperties: false,
} as const

const profileIdQuery = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1, maxLength: 2048 },
  },
  required: ['id'],
  additionalProperties: false,
} as const

function captureHeaders(kind: ProfileKind) {
  return {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${kind}-${new Date().toISOString()}.pprof.gz"`,
  }
}

function isAbortError(error: unknown) {
  return (
    error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  )
}

export default async function routes(fastify: FastifyInstance) {
  registerApiKeyAuth(fastify)
  const shutdown = new AbortController()
  fastify.addHook('preClose', async () => shutdown.abort())
  fastify.addHook('onClose', async () => closeProfileStore())

  for (const [path, kind] of [
    ['profile', 'cpu'],
    ['heap', 'heap'],
  ] as const) {
    fastify.get(
      `/${path}`,
      { schema: { tags: ['pprof'], querystring: captureQuery } },
      async (request, reply) => {
        const seconds = (request.query as { seconds?: number }).seconds ?? 30
        const disconnectSignal = request.signals.disconnect.signal
        const signal = AbortSignal.any([disconnectSignal, shutdown.signal])
        try {
          const result = await profileController.capture({
            class: 'manual',
            kind,
            reason: 'admin',
            seconds,
            signal,
          })
          return reply.headers(captureHeaders(kind)).send(result.body)
        } catch (error) {
          if (error instanceof ProfilingBusyError)
            return reply.status(409).send({ error: error.message })
          if (signal.aborted && isAbortError(error)) {
            if (disconnectSignal.aborted) {
              reply.hijack()
              return
            }
            return reply.status(503).send({ error: 'Server shutting down' })
          }
          throw error
        }
      }
    )
  }

  fastify.get('/heap-snapshot', { schema: { tags: ['pprof'] } }, async (request, reply) => {
    const signal = AbortSignal.any([request.signals.disconnect.signal, shutdown.signal])
    try {
      return reply
        .header('content-type', 'application/json')
        .header(
          'content-disposition',
          `attachment; filename="heap-${new Date().toISOString()}.heapsnapshot"`
        )
        .send(profileController.heapSnapshot(signal))
    } catch (error) {
      if (error instanceof ProfilingBusyError)
        return reply.status(409).send({ error: error.message })
      throw error
    }
  })

  if (!profilingS3Bucket) return

  fastify.get(
    '/profiles',
    {
      schema: {
        tags: ['pprof'],
        querystring: {
          type: 'object',
          properties: {
            class: { type: 'string', enum: ['auto', 'manual'] },
            kind: { type: 'string', enum: ['cpu', 'heap'] },
            service: { type: 'string', pattern: '^[a-zA-Z0-9.-]+$' },
            date: { type: 'string', format: 'date' },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            cursor: {
              type: 'string',
              pattern: '^[A-Za-z0-9_-]+$',
              minLength: 1,
              maxLength: 2048,
            },
          },
          required: ['class'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as {
        class: ProfileClass
        kind?: ProfileKind
        service?: string
        date?: string
        limit?: number
        cursor?: string
      }
      try {
        return await getProfileStore().list({ ...query, limit: query.limit ?? 100 })
      } catch (error) {
        if (error instanceof InvalidProfileCursorError) {
          return reply.status(400).send({ error: error.message })
        }
        throw error
      }
    }
  )

  fastify.get(
    '/profiles/detail',
    { schema: { tags: ['pprof'], querystring: profileIdQuery } },
    async (request, reply) => {
      try {
        return await getProfileStore().head((request.query as { id: string }).id)
      } catch (error) {
        if (error instanceof ProfileNotFoundError)
          return reply.status(404).send({ error: error.message })
        throw error
      }
    }
  )

  fastify.get(
    '/profiles/download',
    { schema: { tags: ['pprof'], querystring: profileIdQuery } },
    async (request, reply) => {
      try {
        const { id } = request.query as { id: string }
        const { object, profile } = await getProfileStore().get(id)
        const filename = `${profile.class}-${profile.service}-${profile.kind}-${profile.startedAt.toISOString().replace(/[:.]/g, '-')}.pprof.gz`
        return reply
          .header('content-type', object.ContentType ?? 'application/gzip')
          .header('content-disposition', `attachment; filename="${filename}"`)
          .send(object.Body)
      } catch (error) {
        if (error instanceof ProfileNotFoundError)
          return reply.status(404).send({ error: error.message })
        throw error
      }
    }
  )
}
