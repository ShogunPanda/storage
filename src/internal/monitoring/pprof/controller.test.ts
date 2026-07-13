import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  encode: vi.fn(),
  heapProfile: vi.fn(),
  heapSnapshot: vi.fn(),
  heapStart: vi.fn(),
  heapStop: vi.fn(),
  logError: vi.fn(),
  put: vi.fn(),
  timeStart: vi.fn(),
  timeStop: vi.fn(),
}))

vi.mock('@internal/monitoring', () => ({
  logger: {},
  logSchema: { error: mocks.logError },
}))
vi.mock('../../../config', () => ({
  getConfig: () => ({
    profilingCpuIntervalMicros: 10_000,
    profilingS3Bucket: 'profiles',
    serviceName: 'storage',
  }),
}))
vi.mock('node:v8', () => ({ getHeapSnapshot: mocks.heapSnapshot }))
vi.mock('./store', () => ({
  getProfileStore: () => ({ put: mocks.put }),
}))
vi.mock('@datadog/pprof', () => ({
  encode: mocks.encode,
  heap: {
    profile: mocks.heapProfile,
    start: mocks.heapStart,
    stop: mocks.heapStop,
  },
  time: {
    start: mocks.timeStart,
    stop: mocks.timeStop,
  },
}))

import { profileController } from './controller'

describe('profile controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.encode.mockResolvedValue(Buffer.from('profile'))
    mocks.heapProfile.mockReturnValue({})
    mocks.heapSnapshot.mockImplementation(() => new PassThrough())
    mocks.timeStop.mockReturnValue({})
    mocks.put.mockResolvedValue(undefined)
  })

  it('stops heap profiling when materializing the profile fails', async () => {
    const error = new Error('profile failed')
    mocks.heapProfile.mockImplementation(() => {
      throw error
    })

    await expect(
      profileController.capture({
        class: 'manual',
        kind: 'heap',
        reason: 'admin',
        seconds: 0,
      })
    ).rejects.toBe(error)

    expect(mocks.heapStop).toHaveBeenCalledOnce()
    expect(profileController.isActive()).toBe(false)
  })

  it('logs a manual archival failure and still returns the captured profile', async () => {
    const error = new Error('S3 unavailable')
    mocks.put.mockRejectedValue(error)

    await expect(
      profileController.capture({
        class: 'manual',
        kind: 'cpu',
        reason: 'admin',
        seconds: 0,
      })
    ).resolves.toEqual({ body: Buffer.from('profile') })

    await vi.waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith(
        {},
        '[Profiling] manual profile archival failed',
        {
          type: 'profiling',
          error,
        }
      )
    )
  })

  it('returns a manual profile without waiting for archival', async () => {
    let resolveUpload: (() => void) | undefined
    mocks.put.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve
        })
    )

    const capture = profileController.capture({
      class: 'manual',
      kind: 'cpu',
      reason: 'admin',
      seconds: 0,
    })
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledOnce())

    expect(profileController.isActive()).toBe(false)
    await expect(capture).resolves.toEqual({ body: Buffer.from('profile') })
    resolveUpload!()
  })

  it('waits for automatic profile archival and propagates its failure', async () => {
    const error = new Error('S3 unavailable')
    mocks.put.mockRejectedValue(error)

    await expect(
      profileController.capture({
        class: 'auto',
        kind: 'cpu',
        reason: 'elu-severe',
        seconds: 0,
      })
    ).rejects.toBe(error)
    expect(mocks.logError).not.toHaveBeenCalled()
  })

  it('destroys an in-flight heap snapshot when its signal aborts', async () => {
    const abort = new AbortController()
    const stream = profileController.heapSnapshot(abort.signal)

    abort.abort()
    await vi.waitFor(() => expect(profileController.isActive()).toBe(false))
    expect(stream.destroyed).toBe(true)
  })
})
