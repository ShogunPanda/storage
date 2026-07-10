export function normalizeStringList(values: readonly string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined
  }

  const normalized = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  )

  return normalized.length > 0 ? normalized : undefined
}

export function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
  return value ? normalizeStringList(value.split(',')) : undefined
}
