import {
  downloadStoredProfile,
  fetchPprofStream,
  fetchStoredProfile,
  fetchStoredProfiles,
  resolvePprofAdminUrl,
} from './client-http'

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('pprof admin HTTP client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves ADMIN_URL path prefixes', () => {
    expect(
      resolvePprofAdminUrl('https://example.com/admin/internal', '/debug/pprof/profile', {
        seconds: 60,
      })
    ).toBe('https://example.com/admin/internal/debug/pprof/profile?seconds=60')
  })

  it('requests raw manual captures', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('profile-data', { headers: { 'content-type': 'application/octet-stream' } })
      )
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchPprofStream({
      adminUrl: 'https://example.com/admin',
      apiKey: 'secret',
      seconds: 90,
      type: 'profile',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/admin/debug/pprof/profile?seconds=90',
      {
        headers: { Accept: 'application/octet-stream', ApiKey: 'secret' },
        method: 'GET',
      }
    )
    expect(await readStream(response.stream)).toBe('profile-data')
  })

  it('lists, reads and downloads stored profiles', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ profiles: [], cursor: 'next' }))
      .mockResolvedValueOnce(
        Response.json({ id: 'abc', class: 'auto', kind: 'cpu', service: 'api' })
      )
      .mockResolvedValueOnce(new Response('stored-profile'))
    vi.stubGlobal('fetch', fetchMock)

    expect(
      await fetchStoredProfiles({
        adminUrl: 'https://example.com/admin',
        apiKey: 'secret',
        class: 'auto',
        service: 'api',
        kind: 'cpu',
        date: '2026-07-13',
        limit: 20,
      })
    ).toEqual({ profiles: [], cursor: 'next' })
    expect(
      await fetchStoredProfile({
        adminUrl: 'https://example.com/admin',
        apiKey: 'secret',
        id: 'abc',
      })
    ).toEqual({ id: 'abc', class: 'auto', kind: 'cpu', service: 'api' })
    expect(
      await readStream(
        (
          await downloadStoredProfile({
            adminUrl: 'https://example.com/admin',
            apiKey: 'secret',
            id: 'abc',
          })
        ).stream
      )
    ).toBe('stored-profile')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/admin/debug/pprof/profiles?class=auto&service=api&kind=cpu&date=2026-07-13&limit=20',
      'https://example.com/admin/debug/pprof/profiles/detail?id=abc',
      'https://example.com/admin/debug/pprof/profiles/download?id=abc',
    ])
  })

  it('caps error response bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('x'.repeat(6000), { status: 502, statusText: 'Bad Gateway' })
        )
    )

    await expect(
      fetchPprofStream({
        adminUrl: 'https://example.com/admin',
        apiKey: 'secret',
        seconds: 30,
        type: 'heap',
      })
    ).rejects.toThrow(/Pprof admin request failed: HTTP 502 Bad Gateway: .*\[truncated\]/)
  })

  it('cancels an error response whose first chunk exactly fills the limit', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(4096, 'x'))
        controller.enqueue(Buffer.from('more'))
      },
      cancel,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 502 }))
    )

    await expect(
      fetchPprofStream({
        adminUrl: 'https://example.com/admin',
        apiKey: 'secret',
        seconds: 30,
        type: 'heap',
      })
    ).rejects.toThrow(/\[truncated\]/)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
