import { parseArgs } from 'node:util'
import {
  downloadStoredProfile,
  fetchPprofStream,
  fetchStoredProfile,
  fetchStoredProfiles,
} from '@internal/monitoring/pprof/client-http'
import { writePprofCaptureToFile } from '@internal/monitoring/pprof/download'
import { generateFlameArtifacts, resolveFlameMdFormat } from '@internal/monitoring/pprof/flame'
import type {
  PprofRequestTargetType,
  ProfileClass,
  ProfileKind,
} from '@internal/monitoring/pprof/types'

const USAGE = `Usage:
  npm run pprof -- capture <profile|heap|heap-snapshot> [--seconds N] [--output FILE] [--flame]
  npm run pprof -- list --class <auto|manual> [--service NAME] [--kind <cpu|heap>] [--days-ago N | --date YYYY-MM-DD | --all] [--limit N] [--cursor TOKEN]
  npm run pprof -- detail <id>
  npm run pprof -- download <id> [--output FILE] [--flame]`

type PprofCommand =
  | {
      name: 'capture'
      target: PprofRequestTargetType
      seconds?: number
      output?: string
      generateFlame: boolean
    }
  | {
      name: 'list'
      class: ProfileClass
      service?: string
      kind?: ProfileKind
      date?: string
      limit?: number
      cursor?: string
    }
  | { name: 'detail'; id: string }
  | { name: 'download'; id: string; output?: string; generateFlame: boolean }

function parsePositiveInteger(value: string | undefined, name: string, maximum?: number) {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new Error(
      `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ''}`
    )
  }
  return parsed
}

function parseNonNegativeInteger(value: string, name: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function parseProfileDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date must use YYYY-MM-DD')
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('date must use YYYY-MM-DD')
  }
  return value
}

function utcDateDaysAgo(now: Date, daysAgo: number) {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)
  )
  if (Number.isNaN(date.getTime())) throw new Error('days-ago is outside the supported date range')
  const formatted = date.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
    throw new Error('days-ago is outside the supported date range')
  }
  return formatted
}

function requireId(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('id must be base64url text')
  return value
}

export function parsePprofCommand(args: string[], now = new Date()): PprofCommand {
  const [name, ...rest] = args

  if (name === 'capture') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        seconds: { type: 'string' },
        output: { type: 'string' },
        flame: { type: 'boolean' },
      },
    })
    const [target, ...extra] = positionals
    if (
      extra.length > 0 ||
      (target !== 'profile' && target !== 'heap' && target !== 'heap-snapshot')
    ) {
      throw new Error(USAGE)
    }
    if (target === 'heap-snapshot' && values.seconds !== undefined) {
      throw new Error('--seconds is not valid for heap-snapshot')
    }
    if (target === 'heap-snapshot' && values.flame) {
      throw new Error('--flame is not valid for heap-snapshot')
    }
    return {
      name,
      target,
      seconds:
        target === 'heap-snapshot'
          ? undefined
          : values.seconds === undefined
            ? 30
            : parsePositiveInteger(values.seconds, 'seconds', 300),
      output: values.output,
      generateFlame: values.flame === true,
    }
  }

  if (name === 'list') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        class: { type: 'string' },
        service: { type: 'string' },
        kind: { type: 'string' },
        'days-ago': { type: 'string' },
        date: { type: 'string' },
        all: { type: 'boolean' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
      },
    })
    if (positionals.length > 0 || (values.class !== 'auto' && values.class !== 'manual')) {
      throw new Error('--class must be auto or manual')
    }
    if (values.kind !== undefined && values.kind !== 'cpu' && values.kind !== 'heap') {
      throw new Error('--kind must be cpu or heap')
    }
    const dateSelectors = [values['days-ago'], values.date, values.all === true].filter(
      (value) => value !== undefined && value !== false
    )
    if (dateSelectors.length > 1)
      throw new Error('--days-ago, --date and --all are mutually exclusive')
    const daysAgo =
      values['days-ago'] === undefined ? 0 : parseNonNegativeInteger(values['days-ago'], 'days-ago')
    return {
      name,
      class: values.class,
      service: values.service,
      kind: values.kind,
      date:
        values.all === true
          ? undefined
          : values.date === undefined
            ? utcDateDaysAgo(now, daysAgo)
            : parseProfileDate(values.date),
      limit:
        values.limit === undefined ? undefined : parsePositiveInteger(values.limit, 'limit', 1000),
      cursor: values.cursor,
    }
  }

  if (name === 'detail') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true })
    if (positionals.length !== 1) throw new Error(USAGE)
    return { name, id: requireId(positionals[0]) }
  }

  if (name === 'download') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string' },
        flame: { type: 'boolean' },
      },
    })
    if (positionals.length !== 1) throw new Error(USAGE)
    return {
      name,
      id: requireId(positionals[0]),
      output: values.output,
      generateFlame: values.flame === true,
    }
  }

  throw new Error(USAGE)
}

async function generateFlame(profilePath: string, enabled: boolean) {
  if (!enabled) return
  await generateFlameArtifacts(profilePath, {
    env: {
      ...process.env,
      FLAME_SOURCEMAPS_DIRS: process.env.FLAME_SOURCEMAPS_DIRS || 'dist',
    },
    mdFormat: resolveFlameMdFormat(process.env.PPROF_FLAME_MD_FORMAT),
  })
}

async function execute(command: PprofCommand, adminUrl: string, apiKey: string) {
  if (command.name === 'list') {
    console.log(
      JSON.stringify(
        await fetchStoredProfiles({
          adminUrl,
          apiKey,
          class: command.class,
          service: command.service,
          kind: command.kind,
          date: command.date,
          limit: command.limit,
          cursor: command.cursor,
        }),
        null,
        2
      )
    )
    return
  }

  if (command.name === 'detail') {
    console.log(
      JSON.stringify(await fetchStoredProfile({ adminUrl, apiKey, id: command.id }), null, 2)
    )
    return
  }

  if (command.name === 'download') {
    const response = await downloadStoredProfile({ adminUrl, apiKey, id: command.id })
    const { outputPath } = await writePprofCaptureToFile(
      response.stream,
      {
        contentDisposition: response.contentDisposition,
        type: 'profile',
      },
      {
        outputPath: command.output,
      }
    )
    await generateFlame(outputPath, command.generateFlame)
    return
  }

  const response = await fetchPprofStream({
    adminUrl,
    apiKey,
    type: command.target,
    seconds: command.seconds,
  })
  const { outputPath } = await writePprofCaptureToFile(
    response.stream,
    {
      contentDisposition: response.contentDisposition,
      type: command.target,
    },
    { outputPath: command.output }
  )
  await generateFlame(outputPath, command.generateFlame)
}

async function main() {
  const adminUrl = process.env.ADMIN_URL
  const apiKey = process.env.ADMIN_API_KEY
  if (!adminUrl) throw new Error('Please provide ADMIN_URL')
  if (!apiKey) throw new Error('Please provide ADMIN_API_KEY')
  await execute(parsePprofCommand(process.argv.slice(2)), adminUrl, apiKey)
}

if (require.main === module) {
  main().catch((error) => {
    process.exitCode = 1
    console.error(error instanceof Error ? error.message : error)
  })
}
