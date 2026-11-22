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
  let tenant = 0

  function createLookup(batched: Awaited<ReturnType<Database['findBucketAndObject']>>) {
    const tenantId = `lookup-tenant-${++tenant}`
    const superUserDb = {
      tenantId,
      findBucketById: vi.fn().mockResolvedValue({ id: 'bucket', public: false }),
      findObject: vi.fn().mockResolvedValue({ id: 'read-as-super-user' }),
    } as unknown as Database
    const db = {
      tenantId,
      findBucketAndObject: vi.fn().mockResolvedValue(batched),
      findObject: vi.fn().mockResolvedValue({ id: 'read-with-rls' }),
      asSuperUser: () => superUserDb,
    } as unknown as Database
    Object.assign(superUserDb, { asSuperUser: () => superUserDb })
    const storage = new Storage({} as StorageBackendAdapter, db, {} as StorageObjectLocator)

    return { db, storage, superUserDb }
  }

  it('uses the object read with RLS for a private bucket', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: { id: 'bucket', public: false } as never,
      object: { id: 'batched' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id', { version: 'v1' })

    expect(lookup.bucket).toEqual({ id: 'bucket', public: false })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'batched' })
    expect(db.findBucketAndObject).toHaveBeenCalledWith({
      bucketId: 'bucket',
      bucketColumns: 'id,public',
      objectName: 'a.txt',
      objectColumns: 'id',
      objectFilters: { excludeDeleteMarkers: true },
      version: 'v1',
      objectAsSuperUser: false,
    })
    expect(db.findObject).not.toHaveBeenCalled()
    expect(superUserDb.findBucketById).not.toHaveBeenCalled()
  })

  it('reports a missing object of a private bucket without reading it again', async () => {
    const { db, storage } = createLookup({ bucket: { id: 'bucket', public: false } as never })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    await expect(lookup.findObject()).rejects.toMatchObject({ code: 'NoSuchKey' })
    expect(db.findObject).not.toHaveBeenCalled()
  })

  it('uses a row RLS let through for a public bucket, and reads a hidden one as the super user', async () => {
    const found = createLookup({
      bucket: { id: 'bucket', public: true } as never,
      object: { id: 'batched' } as never,
    })
    const hidden = createLookup({ bucket: { id: 'bucket', public: true } as never })

    const foundLookup = await found.storage.findBucketAndObject('bucket', 'a.txt', 'id')
    const hiddenLookup = await hidden.storage.findBucketAndObject('bucket', 'a.txt', 'id')

    await expect(foundLookup.findObject()).resolves.toEqual({ id: 'batched' })
    expect(found.superUserDb.findObject).not.toHaveBeenCalled()
    await expect(hiddenLookup.findObject()).resolves.toEqual({ id: 'read-as-super-user' })
    expect(hidden.superUserDb.findObject).toHaveBeenCalledWith(
      'bucket',
      'a.txt',
      'id',
      { excludeDeleteMarkers: true },
      undefined
    )
  })

  it('reads the object of a bucket last seen public as the super user', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: { id: 'bucket', public: true } as never,
    })
    await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(vi.mocked(db.findBucketAndObject).mock.calls[1][0]).toMatchObject({
      objectAsSuperUser: true,
    })
    await expect(lookup.findObject()).rejects.toMatchObject({ code: 'NoSuchKey' })
    expect(superUserDb.findObject).not.toHaveBeenCalled()
  })

  it('never uses an object read as the super user once the bucket turned private', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: { id: 'bucket', public: true } as never,
    })
    await storage.findBucketAndObject('bucket', 'a.txt', 'id')
    vi.mocked(db.findBucketAndObject).mockResolvedValue({
      bucket: { id: 'bucket', public: false } as never,
      object: { id: 'batched-as-super-user' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(vi.mocked(db.findBucketAndObject).mock.calls[1][0]).toMatchObject({
      objectAsSuperUser: true,
    })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'read-with-rls' })
    expect(superUserDb.findObject).not.toHaveBeenCalled()
  })

  it('reads the object as the super user when asked to', async () => {
    const { db, storage } = createLookup({
      bucket: { id: 'bucket', public: false } as never,
      object: { id: 'batched' } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id', {
      objectAsSuperUser: true,
    })

    expect(vi.mocked(db.findBucketAndObject).mock.calls[0][0]).toMatchObject({
      objectAsSuperUser: true,
    })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'batched' })
  })

  it('takes the regular reads when the database cannot batch them', async () => {
    const { db, storage, superUserDb } = createLookup(undefined)

    const lookup = await storage.findBucketAndObject('bucket', 'a.txt', 'id')

    expect(superUserDb.findBucketById).toHaveBeenCalledWith('bucket', 'id,public', {
      dontErrorOnEmpty: true,
    })
    await expect(lookup.findObject()).resolves.toEqual({ id: 'read-with-rls' })
    expect(db.findObject).toHaveBeenCalledTimes(1)
  })

  it('checks the bucket before rejecting an invalid key, as the regular reads do', async () => {
    const { db, storage, superUserDb } = createLookup({
      bucket: { id: 'bucket', public: false } as never,
    })

    const lookup = await storage.findBucketAndObject('bucket', '', 'id')

    expect(db.findBucketAndObject).not.toHaveBeenCalled()
    expect(superUserDb.findBucketById).toHaveBeenCalledTimes(1)
    await expect(lookup.findObject()).rejects.toMatchObject({ code: 'InvalidKey' })
  })
})
