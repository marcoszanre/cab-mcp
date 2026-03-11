const ENV_VAR_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*/

/** Returns true if the string contains at least one `${VAR}` or `$env:VAR` reference. */
export function containsEnvVarRef(value: unknown): boolean {
  return typeof value === 'string' && ENV_VAR_PATTERN.test(value)
}

/**
 * Deep-merge `current` values over `raw`, preserving `${ENV_VAR}` references
 * for fields that the user has not changed since load.
 *
 * For each leaf string field:
 *   - If `current === resolved` → the user didn't change it → keep `raw` (preserves `${...}`)
 *   - Otherwise → the user changed it → use `current`
 *
 * Non-string leaves always use `current`.
 */
export function pickPreservingRaw(
  current: Record<string, unknown>,
  raw: Record<string, unknown>,
  resolved: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw }

  for (const key of Object.keys(current)) {
    const curVal = current[key]
    const rawVal = raw[key]
    const resVal = resolved[key]

    if (curVal !== null && typeof curVal === 'object' && !Array.isArray(curVal)) {
      result[key] = pickPreservingRaw(
        curVal as Record<string, unknown>,
        (rawVal ?? {}) as Record<string, unknown>,
        (resVal ?? {}) as Record<string, unknown>,
      )
    } else {
      // Leaf value: keep raw if the user hasn't changed it
      result[key] = curVal === resVal ? (rawVal ?? curVal) : curVal
    }
  }

  return result
}

/**
 * Build a flat map of dot-paths → raw values for all fields that contain
 * `${ENV_VAR}` references. Used by the UI to show env-var indicators.
 */
export function buildEnvVarFieldMap(
  raw: Record<string, unknown>,
  prefix = '',
): Map<string, string> {
  const map = new Map<string, string>()

  for (const [key, value] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string' && containsEnvVarRef(value)) {
      map.set(path, value)
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of buildEnvVarFieldMap(value as Record<string, unknown>, path)) {
        map.set(k, v)
      }
    }
  }

  return map
}

/**
 * Recursively strips empty string values and resulting empty objects from a value.
 * - Removes keys whose value is `""` (empty string)
 * - Removes keys whose value is an object that becomes empty after stripping
 * - Does NOT strip `false`, `0`, `null`, or non-empty strings
 * - For arrays: keeps all elements but strips empty strings within object elements
 */
export function stripEmptyValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' ? stripEmptyValues(item) : item
    )
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === '') continue
      const stripped = stripEmptyValues(v)
      // Drop objects that became empty after stripping
      if (
        stripped !== null &&
        typeof stripped === 'object' &&
        !Array.isArray(stripped) &&
        Object.keys(stripped as Record<string, unknown>).length === 0
      ) {
        continue
      }
      result[k] = stripped
    }
    return result
  }

  return value
}
