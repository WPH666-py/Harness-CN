/**
 * The hosts this product publishes to, and how to read a release out of each.
 *
 * Two callers need this and neither owns the other: the update channel asks which version is
 * newest and where its installer is, and the first launch asks where the offline seed package is.
 * Both questions are the same request with a different asset name, so the reads live here and the
 * decisions stay with the caller.
 *
 * Integrity follows what each host can prove. GitHub returns a `sha256:` digest for every uploaded
 * asset, so those downloads are verified. Gitee returns none, so its downloads travel over TLS and
 * are reported as unverified rather than silently treated as trusted.
 */

import { isNewer, releaseVersion } from './version.ts'

/** One host this product publishes to. */
export interface ReleaseSource {
  readonly id: string
  readonly kind: 'gitee' | 'github'
  readonly owner: string
  readonly repo: string
}

/** One file a release publishes. */
export interface ReleaseAsset {
  readonly name: string
  readonly url: string
  readonly size: number | undefined
  readonly sha256: string
}

/** One release as this product understands it, from either host. */
export interface ReleaseFacts {
  readonly tag: string
  readonly page: string
  readonly assets: readonly ReleaseAsset[]
  /** Body the host published for this release, empty when it published none readable. */
  readonly notes: string
  /** When the host published it, empty when it did not say. */
  readonly publishedAt: string
}

/**
 * Longest release body the prompt shows.
 *
 * A release body is written for a release page, and the update window is neither scrollable to
 * arbitrary length nor the place to read a changelog. The cap is in characters rather than bytes
 * because the body is Chinese as often as it is English, and a byte cap would cut it into a
 * different number of readable lines depending on which.
 */
const NOTES_LIMIT = 4_000

/**
 * Reduce a published body to text this product is willing to display.
 *
 * Mojibake is dropped rather than guessed back: a host that answered in the wrong encoding
 * produces a body a person cannot read, and showing it would be worse than showing nothing. Every
 * other body is kept, trimmed to the cap.
 * @param body - raw release body.
 * @returns readable notes, or an empty string when the body cannot be shown.
 */
function readableNotes(body: unknown): string {
  if (typeof body !== 'string') return ''
  const cleaned = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
  // Two or more of these on one page mean the bytes were decoded with the wrong charset; one on
  // its own is ordinary text in a Chinese release that happens to mention such a character.
  if ((cleaned.match(/锟斤拷|烫烫烫|屯屯屯/gu) ?? []).length >= 2) return ''
  return cleaned.trim().slice(0, NOTES_LIMIT)
}

/** One host's answer, or the reason it did not answer. */
export interface ReleaseAnswer {
  readonly source: ReleaseSource
  /**
   * Every release this host published, newest first, or undefined when it could not be read.
   *
   * One release is not enough for a caller that needs a specific file: an archive is published
   * once, by the release it belongs to, so a build whose own release did not carry it is served by
   * an older one. What the user is offered to install is a separate question, answered from the
   * newest entry of each host.
   */
  readonly releases: readonly ReleaseFacts[] | undefined
  readonly error: Error | undefined
}

/**
 * Sources are tried in order and every one is asked; the newest version wins.
 *
 * Gitee leads because it answers from inside China, where the GitHub API often does not. Both host
 * the same files, so either can supply a download — but the ordering still decides which request
 * is attempted first, and the check is the request that has to succeed for the user to be told
 * anything at all.
 */
export const RELEASE_SOURCES: readonly ReleaseSource[] = [
  { id: 'gitee', kind: 'gitee', owner: 'ph-wang', repo: 'Harness-CN' },
  { id: 'github', kind: 'github', owner: 'WPH666-py', repo: 'Harness-CN' },
]

export const USER_AGENT = 'Harness-CN-updater'
export const CHECK_TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function getJson(url: string, accept: string, fetchImpl: typeof globalThis.fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`)
  return await response.json()
}

/** Order a release list newest first, dropping tags that are not versions this product compares. */
function newestFirst<T extends { readonly version: string | undefined }>(entries: readonly T[]): T[] {
  return entries
    .filter((entry): entry is T & { version: string } => entry.version !== undefined)
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : 1))
}

/** GitHub publishes an asset digest alongside every upload, which is what makes its files verifiable. */
async function readGithub(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts[]> {
  const releases = await getJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=30`,
    'application/vnd.github+json',
    fetchImpl,
  )
  if (!Array.isArray(releases)) throw new Error('GitHub answered with an unexpected release list')
  const read = newestFirst(releases.filter(isRecord).map((release) => {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    return { release, tag, version: releaseVersion(tag) }
  }))
  if (read.length === 0) throw new Error('GitHub published no release this channel can read')
  return read.map((entry) => {
    const assets = Array.isArray(entry.release.assets) ? entry.release.assets : []
    return {
      tag: entry.tag,
      page: typeof entry.release.html_url === 'string' ? entry.release.html_url : '',
      notes: readableNotes(entry.release.body),
      publishedAt: typeof entry.release.published_at === 'string' ? entry.release.published_at : '',
      assets: assets.filter(isRecord).map((asset): ReleaseAsset => ({
        name: typeof asset.name === 'string' ? asset.name : '',
        url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
        size: typeof asset.size === 'number' ? asset.size : undefined,
        // "sha256:abc..." -> "abc..."; older releases carry no digest at all.
        sha256: typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/iu, '') : '',
      })),
    }
  })
}

/**
 * Gitee answers the same question with a different shape.
 *
 * Its `assets` array holds the published files, and it also offers a per-release attachment
 * endpoint that names the same files; the list read here is the cheaper answer of the two, and the
 * attachment endpoint is consulted only when the list named nothing this product can compare,
 * which is how a release whose attachment record exists but whose asset records do not is still
 * read. Because a prerelease is a normal release there, the whole list is read and compared with
 * the version comparator rather than trusting a "latest" endpoint that orders prereleases
 * differently from this product.
 */
async function readGitee(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts[]> {
  const base = `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`
  const releases = await getJson(`${base}/releases?per_page=100`, 'application/json', fetchImpl)
  if (!Array.isArray(releases)) throw new Error('Gitee answered with an unexpected release list')
  const read = newestFirst(releases.filter(isRecord).map((release) => {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    return {
      assets: Array.isArray(release.assets) ? release.assets.filter(isRecord) : [],
      id: typeof release.id === 'number' ? release.id : undefined,
      notes: readableNotes(release.body),
      publishedAt: typeof release.created_at === 'string' ? release.created_at : '',
      tag,
      version: releaseVersion(tag),
    }
  }))
  if (read.length === 0) throw new Error('Gitee published no release this channel can read')

  return await Promise.all(read.map(async (release): Promise<ReleaseFacts> => {
    const assets: ReleaseAsset[] = []
    for (const asset of release.assets) {
      const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
      const name = typeof asset.name === 'string' ? asset.name : ''
      if (url === '' || name === '') continue
      assets.push({ name, url, size: typeof asset.size === 'number' ? asset.size : undefined, sha256: '' })
    }
    if (assets.length === 0 && release.id !== undefined) {
      try {
        const files = await getJson(`${base}/releases/${String(release.id)}/attach_files`, 'application/json', fetchImpl)
        if (Array.isArray(files)) {
          for (const file of files.filter(isRecord)) {
            const name = typeof file.title === 'string' ? file.title : (typeof file.name === 'string' ? file.name : '')
            if (name === '') continue
            // Gitee has answered this endpoint with a URL under more than one field name, and with no
            // URL at all. The canonical download path is derivable from facts this function already
            // holds, so a release whose attachment record carries only a title is still downloadable.
            const published = [file.download_url, file.browser_download_url, file.url]
              .find(candidate => typeof candidate === 'string' && candidate !== '')
            const url = typeof published === 'string'
              ? published
              : `https://gitee.com/${source.owner}/${source.repo}/releases/download/${release.tag}/${encodeURIComponent(name)}`
            assets.push({ name, url, size: typeof file.size === 'number' ? file.size : undefined, sha256: '' })
          }
        }
      } catch {
        // The version is still usable without an attachment list, and the caller falls through to
        // the next source for a download URL.
      }
    }
    return {
      tag: release.tag,
      page: `https://gitee.com/${source.owner}/${source.repo}/releases/tag/${release.tag}`,
      notes: release.notes,
      publishedAt: release.publishedAt,
      assets,
    }
  }))
}

/**
 * Read every release each host published.
 *
 * Every source is tried even when an earlier one already answered, because the hosts carry
 * different things and a caller may need one fact from a host that cannot supply the file.
 * @param fetchImpl - request implementation.
 * @param sources - hosts to ask, in the order they should be preferred.
 * @returns one answer per source, in the order given.
 */
export async function readReleaseAnswers(
  fetchImpl: typeof globalThis.fetch,
  sources: readonly ReleaseSource[] = RELEASE_SOURCES,
): Promise<readonly ReleaseAnswer[]> {
  return await Promise.all(sources.map(async (source) => {
    try {
      const releases = source.kind === 'gitee'
        ? await readGitee(source, fetchImpl)
        : await readGithub(source, fetchImpl)
      return { source, releases, error: undefined }
    } catch (error) {
      return {
        source,
        releases: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }))
}

/**
 * The releases this channel could read, sources in preference order.
 *
 * A caller offering an update compares whole hosts: the newest release of the first host that
 * answered wins a tie, and a host that could not be read contributes nothing rather than an error
 * the other host's answer would have to overcome.
 * @param answers - what each host answered.
 * @returns one entry per readable release, grouped by source.
 */
export function readableReleases(
  answers: readonly ReleaseAnswer[],
): { readonly source: ReleaseSource; readonly facts: ReleaseFacts }[] {
  return answers.flatMap(answer => (answer.releases ?? []).map(facts => ({ source: answer.source, facts })))
}

/**
 * Find one published file by name in any release either host published.
 *
 * The search goes newest release first, across both sources, so a version's own release is read
 * before any older one. A file a release published is reachable even when that release is not the
 * newest: an offline package is published once, with the version it belongs to, and the build that
 * needs it may well be newer than the host it is fetched from.
 *
 * The result keeps the URL out of the caller's reach only in the sense that it never leaves this
 * process: a page cannot nominate a file for the shell to fetch and then run, because the only
 * names this returns came from a release this product published.
 * @param fetchImpl - request implementation.
 * @param matches - predicate over the published file name.
 * @returns the newest published match, with the release tag that carries it.
 */
export async function findPublishedAsset(
  fetchImpl: typeof globalThis.fetch,
  matches: (name: string) => boolean,
): Promise<{ readonly tag: string; readonly asset: ReleaseAsset } | undefined> {
  const answers = await readReleaseAnswers(fetchImpl)
  const candidates = readableReleases(answers).sort((left, right) => (isNewer(left.facts.tag, right.facts.tag) ? -1 : 1))
  for (const candidate of candidates) {
    const asset = candidate.facts.assets.find(asset => asset.url !== '' && matches(asset.name))
    if (asset !== undefined) return { tag: candidate.facts.tag, asset }
  }
  return undefined
}
