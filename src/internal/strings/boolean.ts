export function parseOptionalBoolean(
  value: string | undefined,
  errorMessage: string
): boolean | undefined {
  const normalized = value?.trim().toLowerCase()

  if (!normalized) {
    return undefined
  }

  if (normalized === 'true') {
    return true
  }

  if (normalized === 'false') {
    return false
  }

  throw new Error(errorMessage)
}
