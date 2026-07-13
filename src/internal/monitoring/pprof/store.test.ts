import type { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getGlobal: vi.fn() }))

vi.mock('../../../config', () => ({
  getConfig: () => ({
    profilingS3Bucket: 'profiles',
    profilingS3ForcePathStyle: false,
    profilingS3Region: 'us-east-1',
    version: '1.2.3',
  }),
}))
vi.mock('@platformatic/globals', () => ({ getGlobal: mocks.getGlobal }))
vi.mock('os', () => ({ hostname: () => 'storage-host-a' }))

import { buildProfileKey, decodeProfileId, ProfileNotFoundError, ProfileStore } from './store'

describe('profile object keys', () => {
  beforeEach(() => mocks.getGlobal.mockReset())

  it('encodes Watt application and worker provenance', () => {
    mocks.getGlobal.mockReturnValue({ applicationId: 'storage', workerId: 3 })
    const key = buildProfileKey({
      class: 'auto',
      kind: 'cpu',
      service: 'api',
      reason: 'elu-sustained',
      startedAt: new Date('2026-07-12T14:30:12.123Z'),
      durationSeconds: 30,
    })

    expect(key).toMatch(
      /^v1\/auto\/\d{13}-[a-f0-9]{12}\/api\/cpu\/d000030s_elu-sustained_storage-host-a_a\.storage_w\.3_p\.\d+_1\.2\.3\.pprof\.gz$/
    )
    const id = Buffer.from(key).toString('base64url')
    expect(decodeProfileId(id)).toBe(key)
  })

  it('omits Watt provenance when running standalone', () => {
    mocks.getGlobal.mockReturnValue(undefined)

    expect(
      buildProfileKey({
        class: 'manual',
        kind: 'heap',
        service: 'worker',
        reason: 'admin',
        startedAt: new Date('2026-07-12T14:30:12.123Z'),
        durationSeconds: 30,
      })
    ).toMatch(
      /^v1\/manual\/\d{13}-[a-f0-9]{12}\/worker\/heap\/d000030s_admin_storage-host-a_a_w_p\.\d+_1\.2\.3\.pprof\.gz$/
    )
  })

  it('sorts newer captures first across services, kinds and dates', () => {
    mocks.getGlobal.mockReturnValue(undefined)
    const newer = buildProfileKey({
      class: 'auto',
      kind: 'heap',
      service: 'worker',
      reason: 'delay-severe',
      startedAt: new Date('2026-07-13T00:00:00.000Z'),
      durationSeconds: 30,
    })
    const older = buildProfileKey({
      class: 'auto',
      kind: 'cpu',
      service: 'api',
      reason: 'elu-sustained',
      startedAt: new Date('2026-07-12T23:59:59.999Z'),
      durationSeconds: 30,
    })

    expect(newer < older).toBe(true)
  })

  it('preserves uploaded Watt provenance when listing', async () => {
    mocks.getGlobal.mockReturnValue({ applicationId: 'storage', workerId: 3 })
    const store = new ProfileStore()
    const send = vi.spyOn(store.client, 'send').mockResolvedValue({} as never)

    try {
      await store.put(
        {
          class: 'auto',
          kind: 'cpu',
          service: 'api',
          reason: 'elu-sustained',
          startedAt: new Date('2026-07-12T14:30:12.123Z'),
          durationSeconds: 30,
        },
        Buffer.from('profile')
      )
      const command = send.mock.calls[0][0] as PutObjectCommand
      const key = command.input.Key!
      expect(command.input).not.toHaveProperty('IfNoneMatch')
      expect(command.input).not.toHaveProperty('Metadata')

      send.mockResolvedValueOnce({ Contents: [{ Key: key }] } as never)
      await expect(store.list({ class: 'auto', limit: 1 })).resolves.toEqual({
        profiles: [
          expect.objectContaining({
            hostname: 'storage-host-a',
            applicationId: 'storage',
            workerId: '3',
            processId: process.pid,
            build: '1.2.3',
          }),
        ],
        cursor: undefined,
      })
    } finally {
      store.destroy()
    }
  })

  it('fills a filtered UTC-day page across S3 scan pages', async () => {
    mocks.getGlobal.mockReturnValue(undefined)
    const store = new ProfileStore()
    const key = (startedAt: string, service = 'api', kind: 'cpu' | 'heap' = 'cpu') =>
      buildProfileKey({
        class: 'auto',
        kind,
        service,
        reason: 'elu-sustained',
        startedAt: new Date(startedAt),
        durationSeconds: 30,
      })
    const nextDay = key('2026-07-13T00:00:00.000Z')
    const wrongService = key('2026-07-12T21:00:00.000Z', 'worker')
    const first = key('2026-07-12T20:00:00.000Z')
    const second = key('2026-07-12T19:00:00.000Z')
    const olderDay = key('2026-07-11T23:59:59.999Z')
    const send = vi
      .spyOn(store.client, 'send')
      .mockResolvedValueOnce({
        Contents: [{ Key: nextDay }, { Key: wrongService }],
        IsTruncated: true,
      } as never)
      .mockResolvedValueOnce({
        Contents: [{ Key: first }, { Key: second }, { Key: olderDay }],
      } as never)

    try {
      const result = await store.list({
        class: 'auto',
        service: 'API',
        kind: 'cpu',
        date: '2026-07-12',
        limit: 2,
      })

      expect(result.profiles.map((profile) => profile.key)).toEqual([first, second])
      expect(Buffer.from(result.cursor!, 'base64url').toString('utf8')).toBe(second)
      expect(send).toHaveBeenCalledTimes(2)
      const firstCommand = send.mock.calls[0][0] as ListObjectsV2Command
      const secondCommand = send.mock.calls[1][0] as ListObjectsV2Command
      expect(firstCommand.input).toMatchObject({
        Prefix: 'v1/auto/',
        MaxKeys: 1000,
      })
      const reverseEnd = `${9_999_999_999_999 - Date.parse('2026-07-13T00:00:00.000Z')}`
      expect(firstCommand.input.StartAfter).toBe(`v1/auto/${reverseEnd}/`)
      expect(secondCommand.input.StartAfter).toBe(wrongService)
    } finally {
      store.destroy()
    }
  })

  it('rejects impossible UTC profile dates before listing S3', async () => {
    const store = new ProfileStore()
    const send = vi.spyOn(store.client, 'send').mockResolvedValue({} as never)

    try {
      await expect(store.list({ class: 'auto', date: '2026-02-30', limit: 20 })).rejects.toThrow(
        'Invalid profile date'
      )
      expect(send).not.toHaveBeenCalled()
    } finally {
      store.destroy()
    }
  })

  it('resumes listing after the last scanned key cursor', async () => {
    mocks.getGlobal.mockReturnValue(undefined)
    const store = new ProfileStore()
    const previousKey = buildProfileKey({
      class: 'auto',
      kind: 'cpu',
      service: 'api',
      reason: 'elu-sustained',
      startedAt: new Date('2026-07-12T20:00:00.000Z'),
      durationSeconds: 30,
    })
    const send = vi.spyOn(store.client, 'send').mockResolvedValue({ Contents: [] } as never)

    try {
      await store.list({
        class: 'auto',
        cursor: Buffer.from(previousKey).toString('base64url'),
        limit: 20,
      })

      const command = send.mock.calls[0][0] as ListObjectsV2Command
      expect(command.input.StartAfter).toBe(previousKey)
      expect(command.input.MaxKeys).toBe(20)
    } finally {
      store.destroy()
    }
  })

  it('rejects ids that are not canonical base64url keys', () => {
    expect(() => decodeProfileId('../profiles')).toThrow('Invalid profile id')
  })

  it('maps invalid and missing profile ids to a not-found error', async () => {
    const store = new ProfileStore()
    const send = vi.spyOn(store.client, 'send')

    try {
      await expect(store.head('not-a-profile')).rejects.toBeInstanceOf(ProfileNotFoundError)
      expect(send).not.toHaveBeenCalled()

      const key = buildProfileKey({
        class: 'auto',
        kind: 'cpu',
        service: 'api',
        reason: 'elu-sustained',
        startedAt: new Date('2026-07-12T14:30:12.123Z'),
        durationSeconds: 30,
      })
      send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound' }))

      await expect(store.head(Buffer.from(key).toString('base64url'))).rejects.toBeInstanceOf(
        ProfileNotFoundError
      )
    } finally {
      store.destroy()
    }
  })

  it('preserves operational S3 failures', async () => {
    const store = new ProfileStore()
    const error = Object.assign(new Error('forbidden'), { name: 'AccessDenied' })
    vi.spyOn(store.client, 'send').mockRejectedValue(error)
    const key = buildProfileKey({
      class: 'manual',
      kind: 'heap',
      service: 'worker',
      reason: 'admin',
      startedAt: new Date('2026-07-12T14:30:12.123Z'),
      durationSeconds: 30,
    })

    try {
      await expect(store.get(Buffer.from(key).toString('base64url'))).rejects.toBe(error)
    } finally {
      store.destroy()
    }
  })
})
