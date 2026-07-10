export function parseNonNegativeInteger(value: string, errorMessage: string): number {
  const normalized = value.trim()

  if (!/^\d+$/.test(normalized)) {
    throw new Error(errorMessage)
  }

  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(errorMessage)
  }

  return parsed
}

export function parsePositiveInteger(value: string, errorMessage: string): number {
  const parsed = parseNonNegativeInteger(value, errorMessage)
  if (parsed === 0) {
    throw new Error(errorMessage)
  }

  return parsed
}
