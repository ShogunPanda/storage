import type { Readable } from 'node:stream'
import { setTimeout as wait } from 'node:timers/promises'
import { getHeapSnapshot } from 'node:v8'
import { logger, logSchema } from '@internal/monitoring'
import { getConfig } from '../../../config'
import { getProfileStore } from './store'
import type { ProfileClass, ProfileKind } from './types'

const { profilingCpuIntervalMicros, profilingS3Bucket, serviceName } = getConfig()

export class ProfilingBusyError extends Error {}

let pprofModule: typeof import('@datadog/pprof') | undefined

export async function loadPprof() {
  pprofModule ??= await import('@datadog/pprof')
  return pprofModule
}

class ProfileController {
  private active = false

  isActive() {
    return this.active
  }

  async capture(options: {
    class: ProfileClass
    kind: ProfileKind
    reason: string
    seconds: number
    service?: string
    signal?: AbortSignal
  }) {
    if (this.active)
      throw new ProfilingBusyError('A profile capture is already active in this isolate')
    this.active = true
    const startedAt = new Date()
    let body: Buffer
    try {
      const pprof = await loadPprof()
      let profile: Parameters<typeof pprof.encode>[0]
      if (options.kind === 'cpu') {
        pprof.time.start({
          intervalMicros: profilingCpuIntervalMicros,
          durationMillis: options.seconds * 1000,
        })
        try {
          await wait(options.seconds * 1000, undefined, { signal: options.signal })
        } finally {
          profile = pprof.time.stop()
        }
      } else {
        pprof.heap.start(512 * 1024, 64)
        try {
          await wait(options.seconds * 1000, undefined, { signal: options.signal })
        } finally {
          try {
            profile = pprof.heap.profile()
          } finally {
            pprof.heap.stop()
          }
        }
      }
      body = await pprof.encode(profile!)
    } finally {
      this.active = false
    }

    if (profilingS3Bucket) {
      const archive = Promise.resolve().then(() =>
        getProfileStore().put(
          {
            class: options.class,
            kind: options.kind,
            reason: options.reason,
            startedAt,
            durationSeconds: options.seconds,
            service: options.service ?? serviceName,
          },
          body
        )
      )
      if (options.class === 'auto') {
        await archive
      } else {
        void archive.catch((error) => {
          logSchema.error(logger, '[Profiling] manual profile archival failed', {
            type: 'profiling',
            error,
          })
        })
      }
    }
    return { body }
  }

  heapSnapshot(signal?: AbortSignal): Readable {
    if (this.active)
      throw new ProfilingBusyError('A profile capture is already active in this isolate')
    this.active = true
    try {
      const stream = getHeapSnapshot()
      const abort = () => stream.destroy()
      const release = () => {
        signal?.removeEventListener('abort', abort)
        this.active = false
      }
      stream.once('end', release).once('close', release).once('error', release)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      return stream
    } catch (error) {
      this.active = false
      throw error
    }
  }
}

export const profileController = new ProfileController()
