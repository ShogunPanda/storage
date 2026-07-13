import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { writePprofCaptureToFile } from './download'

describe('writePprofCaptureToFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pprof-download-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('writes raw pprof data using a safe response filename', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir)
    const result = await writePprofCaptureToFile(Readable.from(['profile-data']), {
      contentDisposition: 'attachment; filename="../cpu.pprof.gz"',
      type: 'profile',
    })

    expect(result.outputPath).toBe(path.join(tempDir, 'dist', 'cpu.pprof.gz'))
    await expect(fs.readFile(result.outputPath, 'utf8')).resolves.toBe('profile-data')
  })

  it('uses an explicit output path', async () => {
    const outputPath = path.join(tempDir, 'chosen', 'heap.pprof.gz')
    const result = await writePprofCaptureToFile(
      Readable.from(['heap-data']),
      { type: 'heap' },
      { outputPath }
    )

    expect(result.outputPath).toBe(outputPath)
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('heap-data')
  })

  it('validates full heap snapshots while streaming them', async () => {
    const outputPath = path.join(tempDir, 'heap.heapsnapshot')
    await writePprofCaptureToFile(
      Readable.from([' {', '"snapshot":true', '} ']),
      { type: 'heap-snapshot' },
      { outputPath }
    )
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(' {"snapshot":true} ')
  })

  it('rejects empty profiles and incomplete heap snapshots', async () => {
    await expect(
      writePprofCaptureToFile(
        Readable.from([]),
        { type: 'profile' },
        { outputPath: path.join(tempDir, 'empty') }
      )
    ).rejects.toThrow('Pprof response was empty.')
    await expect(
      writePprofCaptureToFile(
        Readable.from(['{"snapshot":true']),
        { type: 'heap-snapshot' },
        { outputPath: path.join(tempDir, 'truncated') }
      )
    ).rejects.toThrow('Heap snapshot response is not a complete JSON object.')
    await expect(fs.stat(path.join(tempDir, 'empty'))).rejects.toThrow()
    await expect(fs.stat(path.join(tempDir, 'truncated'))).rejects.toThrow()
  })
})
