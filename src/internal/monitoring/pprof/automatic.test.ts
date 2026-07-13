import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadPprof: vi.fn(),
  logError: vi.fn(),
  profilingS3Bucket: undefined as string | undefined,
}))

vi.mock('../../../config', () => ({
  getConfig: () => ({
    profilingAutomaticEnabled: true,
    profilingS3Bucket: mocks.profilingS3Bucket,
    profilingTriggerDelayP99Ms: 150,
    profilingTriggerElu: 0.55,
    profilingSevereElu: 0.9,
    profilingSevereDelayP99Ms: 1_000,
    profilingMaxCapturesPerHour: 2,
    profilingCooldownSeconds: 300,
    numWorkers: 1,
  }),
}))
vi.mock('@internal/monitoring', () => ({
  logger: {},
  logSchema: { error: mocks.logError },
}))
vi.mock('./controller', () => ({
  loadPprof: mocks.loadPprof,
  ProfilingBusyError: class ProfilingBusyError extends Error {},
  profileController: { capture: vi.fn(), isActive: () => false },
}))

import {
  AutomaticProfileTrigger,
  captureBudgetForIsolate,
  startAutomaticProfiling,
} from './automatic'

describe('AutomaticProfileTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.profilingS3Bucket = undefined
    mocks.loadPprof.mockResolvedValue({})
  })

  it('fires only after sustained mean ELU reaches the threshold', () => {
    const trigger = new AutomaticProfileTrigger()
    for (let i = 0; i < 9; i += 1) expect(trigger.sample(0.52, 0, i * 1000)).toBeUndefined()
    expect(trigger.sample(0.89, 0, 9_000)).toBe('elu-sustained')
  })

  it('fires after three of five high delay samples and applies cooldown', () => {
    const trigger = new AutomaticProfileTrigger()
    expect(trigger.sample(0, 200, 0)).toBeUndefined()
    expect(trigger.sample(0, 0, 1_000)).toBeUndefined()
    expect(trigger.sample(0, 200, 2_000)).toBeUndefined()
    expect(trigger.sample(0, 200, 3_000)).toBeUndefined()
    expect(trigger.sample(0, 200, 4_000)).toBe('event-loop-delay')
    expect(trigger.sample(0, 200, 5_000)).toBeUndefined()
  })

  it('fires immediately for severe ELU', () => {
    expect(new AutomaticProfileTrigger().sample(0.9, 0, 0)).toBe('elu-severe')
  })

  it('honors an explicitly disabled capture budget', () => {
    expect(new AutomaticProfileTrigger(0).sample(0.9, 0, 0)).toBeUndefined()
  })

  it('logs and disables automatic profiling when the bucket is missing', async () => {
    await expect(
      startAutomaticProfiling({ service: 'api', signal: new AbortController().signal })
    ).resolves.toBeUndefined()
    expect(mocks.logError).toHaveBeenCalledWith({}, '[Profiling] automatic profiling disabled', {
      type: 'profiling',
      error: expect.objectContaining({
        message: 'PROFILING_S3_BUCKET is required when automatic profiling is enabled',
      }),
    })
  })

  it('logs and disables automatic profiling when the profiler cannot load', async () => {
    const error = new Error('native profiler unavailable')
    mocks.profilingS3Bucket = 'profiles'
    mocks.loadPprof.mockRejectedValue(error)
    vi.resetModules()
    const { startAutomaticProfiling: start } = await import('./automatic')

    await expect(
      start({ service: 'api', signal: new AbortController().signal })
    ).resolves.toBeUndefined()
    expect(mocks.logError).toHaveBeenCalledWith({}, '[Profiling] automatic profiling disabled', {
      type: 'profiling',
      error,
    })
  })

  it('partitions the container capture budget across Watt isolates', () => {
    const budgets = Array.from({ length: 4 }, (_, workerId) =>
      captureBudgetForIsolate(6, 4, `${workerId}`)
    )

    expect(budgets).toEqual([2, 2, 1, 1])
    expect(budgets.reduce((total, budget) => total + budget, 0)).toBe(6)
    expect(captureBudgetForIsolate(6, 4, undefined)).toBe(6)
  })
})
