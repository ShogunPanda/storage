import { setQueueForTesting } from '@internal/queue'
import { describe, expect, it, vi } from 'vitest'
import { StorageBackendAdapter } from './backend'
import { Database } from './database'
import { ObjectAdminDeleteAllBefore } from './events'
import { StorageObjectLocator } from './locator'
import { Storage } from './storage'

function createStorage(dbOverrides: Partial<Database> = {}) {
  const deleteObject = vi.fn()
  const testPermission = vi.fn()
  const db = {
    tenantId: 'tenant-id',
    reqId: 'req-id',
    sbReqId: 'sb-req-id',
    tenant: vi.fn(() => ({ ref: 'tenant-id', host: 'localhost' })),
    findBucketById: vi.fn().mockResolvedValue({ name: 'bucket' }),
    testPermission,
    countObjectsInBucket: vi.fn().mockResolvedValue(1),
    listObjects: vi.fn().mockResolvedValue([{ id: 'object-id', name: 'visible.txt' }]),
    deleteObject,
    ...dbOverrides,
  } as unknown as Database
  const storage = new Storage({} as StorageBackendAdapter, db, {} as StorageObjectLocator)

  return {
    db,
    deleteObject,
    storage,
    testPermission,
  }
}

function stubQueue() {
  const produce = vi.fn().mockResolvedValue(undefined)
  setQueueForTesting({ produce })
  return produce
}

describe('Storage.emptyBucket', () => {
  it('enqueues deletion without probing object or bucket permissions', async () => {
    const produce = stubQueue()
    const { deleteObject, storage, testPermission } = createStorage()

    await storage.emptyBucket('bucket')

    expect(testPermission).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
    expect(produce).toHaveBeenCalledOnce()
    expect(produce.mock.calls[0][0]).toBeInstanceOf(ObjectAdminDeleteAllBefore)
  })

  it('does not enqueue when the bucket is already empty', async () => {
    const produce = stubQueue()
    const { storage } = createStorage({
      listObjects: vi.fn().mockResolvedValue([]),
    })

    await storage.emptyBucket('bucket')

    expect(produce).not.toHaveBeenCalled()
  })
})

describe('Storage.findBucketAndObject', () => {
  const privateBucket = { id: 'bucket', public: false } as never
  const publicBucket = { id: 'bucket', public: true } as never

  function createLookup(batched: Awaited<ReturnType<Database['findBucketAndObject']>>) {
    const superUserDb = {
      tenantId: 'tenant-id',
      findBucketById: vi.fn().mockResolvedValue({ id: 'bucket', public: false }),
      findObject: vi.fn().mockResolvedValue({ id: 'read-as-super-user' }),
    } as unknown as Database
    const db = {
      tenantId: 'tenant-id',
      findBucketAndObject: vi.fn().mockResolvedValue(batched),
      findObject: vi.fn().mockResolvedValue({ id: 'read-with-rls' }),
      asSuperUser: () => superUserDb,
    } as unknown as Database
    Object.assign(superUserDb, { asSuperUser: () => superUserDb })
    const storage = new Storage({} as StorageBackendAdapter, db, {} as StorageObjectLocator)

    return { db, storage, superUserDb }
  }

  it('reads the bucket and the object in one round trip, as the bucket calls for', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: publicBucket,
      object: { id: 'batched' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id', { version: 'v1' })

    expect(db.findBucketAndObject).toHaveBeenCalledWith({
      bucketId: 'bucket',
      bucketColumns: 'id,public',
      objectName: 'a.txt',
      objectColumns: 'id',
      objectFilters: { excludeDeleteMarkers: true },
      version: 'v1',
      objectAsSuperUser: false,
    })
    expect(lookup.bucket).toEqual({ id: 'bucket', public: true })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'batched' })
    expect(superUserDb.findBucketById).not.toHaveBeenCalled()
    expect(superUserDb.findObject).not.toHaveBeenCalled()
    expect(db.findObject).not.toHaveBeenCalled()
  })

  it('uses the batched row of a private bucket too: the database read it with RLS', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: privateBucket,
      object: { id: 'batched-with-rls' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    await expect(lookup.findObject()).resolves.toEqual({ id: 'batched-with-rls' })
    expect(db.findObject).not.toHaveBeenCalled()
    expect(superUserDb.findObject).not.toHaveBeenCalled()
  })

  it.each([
    ['public', publicBucket],
    ['private', privateBucket],
  ])('reports a missing object of a %s bucket without reading it again', async (_, bucket) => {
    const { db, storage, superUserDb } = createLookup({ bucket })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    await expect(lookup.findObject()).rejects.toMatchObject({ code: 'NoSuchKey' })
    expect(superUserDb.findObject).not.toHaveBeenCalled()
    expect(db.findObject).not.toHaveBeenCalled()
  })

  it('asks for the object as the super user when told to', async () => {
    const { db, storage } = createLookup({
      bucket: privateBucket,
      object: { id: 'batched' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id', {
      objectAsSuperUser: true,
    })

    expect(db.findBucketAndObject).toHaveBeenCalledWith(
      expect.objectContaining({ objectAsSuperUser: true })
    )
    await expect(lookup.findObject()).resolves.toEqual({ id: 'batched' })
    expect(db.findObject).not.toHaveBeenCalled()
  })

  it('remembers nothing between calls: each one reads the bucket again', async () => {
    const { db, storage } = createLookup(undefined)
    vi.mocked(db.findBucketAndObject).mockResolvedValueOnce({
      bucket: publicBucket,
      object: { id: 'read-as-super-user' } as never,
    })
    vi.mocked(db.findBucketAndObject).mockResolvedValueOnce({
      bucket: privateBucket,
      object: { id: 'read-with-rls' } as never,
    })

    const first = await storage.findBucketAndObject('bucket', 'a.txt', 'id')
    const second = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(first.bucket).toEqual(publicBucket)
    expect(second.bucket).toEqual(privateBucket)
    await expect(second.findObject()).resolves.toEqual({ id: 'read-with-rls' })
    expect(db.findBucketAndObject).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(db.findBucketAndObject).mock.calls.map(([query]) => query.objectAsSuperUser)
    ).toEqual([false, false])
  })

  it('returns no bucket when there is none', async () => {
    const { storage } = createLookup({ bucket: undefined })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(lookup.bucket).toBeUndefined()
  })

  it('takes the regular reads when the database cannot batch them', async () => {
    const { db, storage, superUserDb } = createLookup(undefined)

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(db.findBucketAndObject).toHaveBeenCalledTimes(1)
    expect(superUserDb.findBucketById).toHaveBeenCalledWith('bucket', 'id,public', {
      dontErrorOnEmpty: true,
    })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'read-with-rls' })
    expect(db.findObject).toHaveBeenCalledTimes(1)
  })

  it('checks the bucket before rejecting an invalid key, as the regular reads do', async () => {
    const { db, storage, superUserDb } = createLookup({ bucket: privateBucket })

    const lookup = await storage.findBucketAndObject('bucket', '', 'id')

    expect(db.findBucketAndObject).not.toHaveBeenCalled()
    expect(superUserDb.findBucketById).toHaveBeenCalledTimes(1)
    await expect(lookup.findObject()).rejects.toMatchObject({ code: 'InvalidKey' })
  })
})
