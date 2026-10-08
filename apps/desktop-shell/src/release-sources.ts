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
}

/** One host's answer, or the reason it did not answer. */
export interface ReleaseAnswer {
  readonly source: ReleaseSource
  readonly facts: ReleaseFacts | undefined
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
async function readGithub(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts> {
  const releases = await getJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=30`,
    'application/vnd.github+json',
    fetchImpl,
  )
  if (!Array.isArray(releases)) throw new Error('GitHub answered with an unexpected release list')
  const newest = newestFirst(releases.filter(isRecord).map((release) => {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    return { release, tag, version: releaseVersion(tag) }
  }))[0]
  if (newest === undefined) throw new Error('GitHub published no release this channel can read')
  const assets = Array.isArray(newest.release.assets) ? newest.release.assets : []
  return {
    tag: newest.tag,
    page: typeof newest.release.html_url === 'string' ? newest.release.html_url : '',
    assets: assets.filter(isRecord).map((asset): ReleaseAsset => ({
      name: typeof asset.name === 'string' ? asset.name : '',
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      size: typeof asset.size === 'number' ? asset.size : undefined,
      // "sha256:abc..." -> "abc..."; older releases carry no digest at all.
      sha256: typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/iu, '') : '',
    })),
  }
}

/**
 * Gitee answers the same question with a different shape.
 *
 * Its `assets` array holds only the auto-generated source archives, so an uploaded attachment has
 * to be requested separately; and because a prerelease is a normal release there, the whole list is
 * read and compared with the version comparator rather than trusting a "latest" endpoint that
 * orders prereleases differently from this product.
 */
async function readGitee(source: ReleaseSource, fetchImpl: typeof globalThis.fetch): Promise<ReleaseFacts> {
  const base = `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`
  const releases = await getJson(`${base}/releases?per_page=100`, 'application/json', fetchImpl)
  if (!Array.isArray(releases)) throw new Error('Gitee answered with an unexpected release list')
  const newest = newestFirst(releases.filter(isRecord).map((release) => {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    return {
      assets: Array.isArray(release.assets) ? release.assets.filter(isRecord) : [],
      id: typeof release.id === 'number' ? release.id : undefined,
      tag,
      version: releaseVersion(tag),
    }
  }))[0]
  if (newest === undefined) throw new Error('Gitee published no release this channel can read')

  const assets: ReleaseAsset[] = []
  // A release also lists `/releases/download/` links; they are the fallback when the attachment
  // endpoint refuses, which it does for a repository that has none.
  for (const asset of newest.assets) {
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!url.includes('/releases/download/')) continue
    assets.push({
      name: typeof asset.name === 'string' ? asset.name : '',
      url,
      size: typeof asset.size === 'number' ? asset.size : undefined,
      sha256: '',
    })
  }
  if (newest.id !== undefined) {
    try {
      const files = await getJson(`${base}/releases/${String(newest.id)}/attach_files`, 'application/json', fetchImpl)
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
            : `https://gitee.com/${source.owner}/${source.repo}/releases/download/${newest.tag}/${encodeURIComponent(name)}`
          assets.push({ name, url, size: typeof file.size === 'number' ? file.size : undefined, sha256: '' })
        }
      }
    } catch {
      // The version is still usable without an attachment list, and the caller falls through to
      // the next source for a download URL.
    }
  }
  return {
    tag: newest.tag,
    page: `https://gitee.com/${source.owner}/${source.repo}/releases/tag/${newest.tag}`,
    assets,
  }
}

/**
 * Ask every source, keeping each answer separate.
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
      const facts = source.kind === 'gitee'
        ? await readGitee(source, fetchImpl)
        : await readGithub(source, fetchImpl)
      return { source, facts, error: undefined }
    } catch (error) {
      return {
        source,
        facts: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }))
}

/**
 * Find one published file by name across every host that has it.
 *
 * The result keeps the URL out of the caller's reach only in the sense that it never leaves this
 * process: a page cannot nominate a file for the shell to fetch and then run, because the only
 * names this returns came from a release this product published.
 * @param fetchImpl - request implementation.
 * @param matches - predicate over the published file name.
 * @returns the first published match, with the release tag that carries it.
 */
export async function findPublishedAsset(
  fetchImpl: typeof globalThis.fetch,
  matches: (name: string) => boolean,
): Promise<{ readonly tag: string; readonly asset: ReleaseAsset } | undefined> {
  const answers = await readReleaseAnswers(fetchImpl)
  const candidates = answers
    .filter((answer): answer is ReleaseAnswer & { facts: ReleaseFacts } => answer.facts !== undefined)
    .sort((left, right) => (isNewer(left.facts.tag, right.facts.tag) ? -1 : 1))
  for (const answer of candidates) {
    const asset = answer.facts.assets.find(candidate => candidate.url !== '' && matches(candidate.name))
    if (asset !== undefined) return { tag: answer.facts.tag, asset }
  }
  return undefined
}
