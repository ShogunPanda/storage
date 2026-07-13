import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { logger, logSchema } from '@internal/monitoring'
import { getConfig } from '../../../config'
import { resolveRuntimeIdentity } from '../runtime-identity'
import { loadPprof, ProfilingBusyError, profileController } from './controller'

const {
  profilingAutomaticEnabled,
  profilingCaptureSeconds,
  profilingCooldownSeconds,
  profilingMaxCapturesPerHour,
  numWorkers,
  profilingS3Bucket,
  profilingSevereDelayP99Ms,
  profilingSevereElu,
  profilingTriggerDelayP99Ms,
  profilingTriggerElu,
} = getConfig()

export function captureBudgetForIsolate(
  maxCapturesPerHour: number,
  workerCount: number,
  workerId: string | undefined
) {
  if (workerId === undefined) return maxCapturesPerHour

  const numericWorkerId = Number(workerId)
  if (
    !Number.isSafeInteger(workerCount) ||
    workerCount <= 1 ||
    !Number.isSafeInteger(numericWorkerId) ||
    numericWorkerId < 0 ||
    numericWorkerId >= workerCount
  ) {
    return maxCapturesPerHour
  }

  const capturesPerWorker = Math.floor(maxCapturesPerHour / workerCount)
  return capturesPerWorker + (numericWorkerId < maxCapturesPerHour % workerCount ? 1 : 0)
}

const isolateCaptureBudget = captureBudgetForIsolate(
  profilingMaxCapturesPerHour,
  numWorkers,
  resolveRuntimeIdentity().workerId
)

interface AutomaticProfilingOptions {
  service: string
  signal: AbortSignal
}

export class AutomaticProfileTrigger {
  private elu: number[] = []
  private delays: boolean[] = []
  private captures: number[] = []
  private cooldownUntil = 0

  constructor(private readonly maxCapturesPerHour = isolateCaptureBudget) {}

  private selectReason(elu: number, delayP99Ms: number, meanElu: number) {
    if (elu >= profilingSevereElu) return 'elu-severe'
    if (delayP99Ms >= profilingSevereDelayP99Ms) return 'event-loop-delay-severe'
    if (this.elu.length === 10 && meanElu >= profilingTriggerElu) return 'elu-sustained'
    if (this.delays.length === 5 && this.delays.filter(Boolean).length >= 3) {
      return 'event-loop-delay'
    }
  }

  sample(elu: number, delayP99Ms: number, now = Date.now(), canFire = true) {
    this.elu.push(elu)
    if (this.elu.length > 10) this.elu.shift()
    this.delays.push(delayP99Ms >= profilingTriggerDelayP99Ms)
    if (this.delays.length > 5) this.delays.shift()
    this.captures = this.captures.filter((at) => now - at < 3_600_000)
    const meanElu = this.elu.reduce((sum, value) => sum + value, 0) / this.elu.length
    const reason = this.selectReason(elu, delayP99Ms, meanElu)
    if (
      !reason ||
      !canFire ||
      now < this.cooldownUntil ||
      this.captures.length >= this.maxCapturesPerHour
    )
      return
    this.captures.push(now)
    this.cooldownUntil = now + profilingCooldownSeconds * 1000
    return reason
  }
}

export async function startAutomaticProfiling(options: AutomaticProfilingOptions) {
  if (!profilingAutomaticEnabled) return
  if (!profilingS3Bucket) {
    logSchema.error(logger, '[Profiling] automatic profiling disabled', {
      type: 'profiling',
      error: new Error('PROFILING_S3_BUCKET is required when automatic profiling is enabled'),
    })
    return
  }
  try {
    await loadPprof()
  } catch (error) {
    logSchema.error(logger, '[Profiling] automatic profiling disabled', {
      type: 'profiling',
      error,
    })
    return
  }
  if (options.signal.aborted) return
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  const trigger = new AutomaticProfileTrigger()
  let previous = performance.eventLoopUtilization()
  histogram.enable()

  const sampleAndCaptureProfile = () => {
    const current = performance.eventLoopUtilization()
    const elu = performance.eventLoopUtilization(current, previous).utilization
    previous = current
    const reason = trigger.sample(
      elu,
      histogram.percentile(99) / 1e6,
      Date.now(),
      !profileController.isActive()
    )
    histogram.reset()
    if (!reason) return
    void profileController
      .capture({
        class: 'auto',
        kind: 'cpu',
        reason,
        seconds: profilingCaptureSeconds,
        service: options.service,
        signal: options.signal,
      })
      .catch((error) => {
        if (!(error instanceof ProfilingBusyError) && error?.name !== 'AbortError')
          logSchema.error(logger, '[Profiling] automatic capture failed', {
            type: 'profiling',
            error,
          })
      })
  }

  const timer = setInterval(sampleAndCaptureProfile, 1_000)
  timer.unref()
  options.signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer)
      histogram.disable()
    },
    { once: true }
  )
}
