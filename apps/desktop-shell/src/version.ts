/**
 * Release-version ordering for the update channel.
 *
 * Harness-CN publishes prereleases (`0.1.5-rc.3`), so this cannot be a "compare three numbers"
 * helper: a channel that read `0.1.5-rc.2` and `0.1.5-rc.3` as the same version would report that
 * the build is current and never offer the next one. The rules implemented here are semver's
 * precedence rules, and nothing else about semver is needed or claimed.
 */

/** One parsed release version. */
export interface ParsedVersion {
  readonly core: readonly [number, number, number]
  /** Prerelease identifiers, empty for a final release. */
  readonly prerelease: readonly string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const NUMERIC_IDENTIFIER = /^\d+$/u

/**
 * Parse a release tag, or report that it is not a version.
 * @param tag - release tag, with or without a leading `v`.
 * @returns the parsed version, or undefined when the tag is not one.
 */
export function parseVersion(tag: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(tag.trim())
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Order two versions by semver precedence.
 * @param left - first version.
 * @param right - second version.
 * @returns a negative number, zero, or a positive number.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  // A release outranks any of its own prereleases.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const bothNumeric = NUMERIC_IDENTIFIER.test(a) && NUMERIC_IDENTIFIER.test(b)
    if (bothNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Accept a release tag as a version this channel can compare, or reject it. */
export function releaseVersion(tag: string): string | undefined {
  return parseVersion(tag) === undefined ? undefined : tag.trim().replace(/^v/u, '')
}

/**
 * Report whether `candidate` is strictly newer than `current`.
 * @param candidate - version a release offers.
 * @param current - version of the running build.
 * @returns whether the candidate should be offered as an update.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate)
  const right = parseVersion(current)
  if (left === undefined || right === undefined) return false
  return compareVersions(left, right) > 0
}
