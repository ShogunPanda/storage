import { randomBytes } from 'node:crypto'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { getConfig } from '../../../config'
import { resolveRuntimeIdentity } from '../runtime-identity'
import type { ProfileClass, ProfileKind } from './types'

export interface ProfileIdentity {
  class: ProfileClass
  kind: ProfileKind
  service: string
  reason: string
  startedAt: Date
  durationSeconds: number
}

export interface StoredProfile extends ProfileIdentity {
  id: string
  key: string
  hostname: string
  applicationId?: string
  workerId?: string
  processId: number
  build: string
  size?: number
  etag?: string
}

export class InvalidProfileCursorError extends Error {}
export class ProfileNotFoundError extends Error {}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9.-]{0,63}$/
const CAPTURE_SEGMENT = /^(\d{13})-([a-f0-9]{12})$/
const DURATION_SEGMENT = /^d\d{6}s$/
const APPLICATION_SEGMENT = /^a(?:\.[a-z0-9][a-z0-9.-]{0,63})?$/
const WORKER_SEGMENT = /^w(?:\.[a-z0-9][a-z0-9.-]{0,63})?$/
const PROCESS_SEGMENT = /^p\.\d+$/
const REVERSE_EPOCH_MAX = 9_999_999_999_999
const PROFILE_SCAN_PAGE_SIZE = 1000
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const {
  profilingS3Bucket,
  profilingS3Endpoint,
  profilingS3ForcePathStyle,
  profilingS3Region,
  version,
} = getConfig()

function slug(value: string, fallback: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return SAFE_SEGMENT.test(normalized) ? normalized : fallback
}

function encodeId(key: string) {
  return Buffer.from(key).toString('base64url')
}

function reverseTimestamp(timestamp: number) {
  return `${REVERSE_EPOCH_MAX - timestamp}`.padStart(13, '0')
}

function profileDateRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid profile date')
  const start = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid profile date')
  }
  return { start, end: start + DAY_MILLISECONDS }
}

export function decodeProfileId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid profile id')
  const key = Buffer.from(id, 'base64url').toString('utf8')
  if (encodeId(key) !== id || key.includes('..') || key.startsWith('/'))
    throw new Error('Invalid profile id')
  return key
}

function resolveProfileId(id: string) {
  let key: string
  try {
    key = decodeProfileId(id)
  } catch {
    throw new ProfileNotFoundError('Profile not found')
  }
  const profile = parseProfileKey(key)
  if (!profile) throw new ProfileNotFoundError('Profile not found')
  return { key, profile }
}

function isS3ProfileNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'NoSuchKey' || name === 'NotFound'
}

export function buildProfileKey(identity: ProfileIdentity) {
  const at = identity.startedAt
  const reverseMs = reverseTimestamp(at.getTime())
  const captureId = randomBytes(6).toString('hex')
  const runtime = resolveRuntimeIdentity()
  const application = runtime.applicationId ? `a.${slug(runtime.applicationId, 'unknown')}` : 'a'
  const worker = runtime.workerId ? `w.${slug(runtime.workerId, 'unknown')}` : 'w'
  const instance = slug(runtime.hostname, 'unknown')
  const processId = `p.${process.pid}`
  const build = slug(version, 'unknown')
  const filename =
    [
      `d${`${identity.durationSeconds}`.padStart(6, '0')}s`,
      slug(identity.reason, 'unknown'),
      instance,
      application,
      worker,
      processId,
      build,
    ].join('_') + '.pprof.gz'

  return [
    'v1',
    identity.class,
    `${reverseMs}-${captureId}`,
    slug(identity.service, 'unknown'),
    identity.kind,
    filename,
  ].join('/')
}

function parseProfileKey(key: string): StoredProfile | undefined {
  const root = 'v1/'
  if (!key.startsWith(root)) return
  const parts = key.slice(root.length).split('/')
  if (parts.length !== 5) return
  const [profileClass, capture, service, kind, filename] = parts
  if ((profileClass !== 'auto' && profileClass !== 'manual') || (kind !== 'cpu' && kind !== 'heap'))
    return
  const captureMatch = capture.match(CAPTURE_SEGMENT)
  if (!captureMatch) return
  if (!filename.endsWith('.pprof.gz')) return
  const fields = filename.slice(0, -'.pprof.gz'.length).split('_')
  if (fields.length !== 7) return
  const durationSeconds = Number.parseInt(fields[0].slice(1, -1), 10)
  const applicationId = fields[3] === 'a' ? undefined : fields[3].slice(2)
  const workerId = fields[4] === 'w' ? undefined : fields[4].slice(2)
  const processId = Number.parseInt(fields[5].slice(2), 10)
  const startedAtMs = REVERSE_EPOCH_MAX - Number(captureMatch[1])
  const startedAt = new Date(startedAtMs)
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < 0 ||
    Number.isNaN(startedAt.getTime()) ||
    reverseTimestamp(startedAt.getTime()) !== captureMatch[1] ||
    !DURATION_SEGMENT.test(fields[0]) ||
    !SAFE_SEGMENT.test(fields[1]) ||
    !APPLICATION_SEGMENT.test(fields[3]) ||
    !WORKER_SEGMENT.test(fields[4]) ||
    !PROCESS_SEGMENT.test(fields[5]) ||
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    !SAFE_SEGMENT.test(service) ||
    !SAFE_SEGMENT.test(fields[2]) ||
    !SAFE_SEGMENT.test(fields[6])
  )
    return
  return {
    id: encodeId(key),
    key,
    class: profileClass,
    kind,
    service,
    reason: fields[1],
    startedAt,
    durationSeconds,
    hostname: fields[2],
    applicationId,
    workerId,
    processId,
    build: fields[6],
  }
}

export class ProfileStore {
  readonly client: S3Client
  readonly bucket: string

  constructor() {
    if (!profilingS3Bucket) throw new Error('PROFILING_S3_BUCKET is not configured')
    this.bucket = profilingS3Bucket
    this.client = new S3Client({
      region: profilingS3Region,
      endpoint: profilingS3Endpoint,
      forcePathStyle: profilingS3ForcePathStyle,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 30_000 }),
    })
  }

  async put(identity: ProfileIdentity, body: Buffer) {
    const key = buildProfileKey(identity)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
      })
    )
  }

  async list(options: {
    class: ProfileClass
    kind?: ProfileKind
    service?: string
    limit: number
    cursor?: string
    date?: string
  }) {
    const prefix = `v1/${options.class}/`
    const dateRange = options.date ? profileDateRange(options.date) : undefined
    const service = options.service ? slug(options.service, 'unknown') : undefined
    let startAfter: string | undefined
    if (options.cursor) {
      try {
        startAfter = decodeProfileId(options.cursor)
      } catch {
        throw new InvalidProfileCursorError('Invalid profile cursor')
      }
      if (!startAfter.startsWith(prefix))
        throw new InvalidProfileCursorError('Invalid profile cursor')
    } else if (dateRange) {
      // Generated capture keys use '-' after the reverse timestamp. '/' sorts after
      // it, excluding captures at the next day's exact UTC boundary.
      startAfter = `${prefix}${reverseTimestamp(dateRange.end)}/`
    }

    const profiles: StoredProfile[] = []
    const maxKeys = service || options.kind ? PROFILE_SCAN_PAGE_SIZE : options.limit
    while (profiles.length < options.limit) {
      const pageStartAfter = startAfter
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          StartAfter: startAfter,
          MaxKeys: maxKeys,
        })
      )
      const objects = response.Contents ?? []
      let reachedDateEnd = false

      for (let index = 0; index < objects.length; index++) {
        const object = objects[index]
        if (!object.Key) continue
        startAfter = object.Key
        const parsed = parseProfileKey(object.Key)
        if (!parsed) continue
        if (dateRange && parsed.startedAt.getTime() >= dateRange.end) continue
        if (dateRange && parsed.startedAt.getTime() < dateRange.start) {
          reachedDateEnd = true
          break
        }
        if (options.kind && parsed.kind !== options.kind) continue
        if (service && parsed.service !== service) continue

        profiles.push({ ...parsed, size: object.Size, etag: object.ETag })
        if (profiles.length === options.limit) {
          const hasMore =
            index < objects.length - 1 ||
            response.IsTruncated === true ||
            response.NextContinuationToken !== undefined
          return { profiles, cursor: hasMore ? encodeId(object.Key) : undefined }
        }
      }

      if (
        reachedDateEnd ||
        objects.length === 0 ||
        startAfter === pageStartAfter ||
        (response.IsTruncated !== true && response.NextContinuationToken === undefined)
      ) {
        break
      }
    }

    return { profiles, cursor: undefined }
  }

  async head(id: string) {
    const { key, profile } = resolveProfileId(id)
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      )
      return {
        ...profile,
        size: response.ContentLength,
        etag: response.ETag,
      }
    } catch (error) {
      if (isS3ProfileNotFoundError(error)) throw new ProfileNotFoundError('Profile not found')
      throw error
    }
  }

  async get(id: string) {
    const { key, profile } = resolveProfileId(id)
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return { object, profile }
    } catch (error) {
      if (isS3ProfileNotFoundError(error)) throw new ProfileNotFoundError('Profile not found')
      throw error
    }
  }

  destroy() {
    this.client.destroy()
  }
}

let store: ProfileStore | undefined
export function getProfileStore() {
  if (!store) store = new ProfileStore()
  return store
}
export function closeProfileStore() {
  store?.destroy()
  store = undefined
}
