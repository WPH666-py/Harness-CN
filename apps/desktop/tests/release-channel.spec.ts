/**
 * Behavior of the release channel the desktop shell actually ships.
 *
 * These cases drive `createReleaseChannel` through an injected `fetch`, which is the same seam the
 * sidecar uses in production: what they pin is which host is asked first, which release wins when
 * two hosts disagree, and how a download reports itself. The previous suite covered the
 * Electron-era GitHub backend, which no shipping build selects.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createReleaseChannel, downloadVerified, safeFileName, UPDATE_CANCELLED } = await import(
  '../../desktop-shell/src/release-channel.ts',
)

/** One GitHub-shaped releases answer. */
function githubReleases(entries: readonly { tag: string; asset: string; body?: string }[]): string {
  return JSON.stringify(entries.map(entry => ({
    tag_name: entry.tag,
    html_url: `https://github.com/WPH666-py/Harness-CN/releases/tag/${entry.tag}`,
    body: entry.body ?? '',
    published_at: '2026-10-10T00:00:00Z',
    assetss: undefined,
    assets: [{
      name: entry.asset,
      size: 4,
      browser_download_url: `https://github.com/WPH666-py/Harness-CN/releases/download/${entry.tag}/${entry.asset}`,
      digest: `sha256:${'a'.repeat(64)}`,
    }],
  })))
}

/** One Gitee-shaped releases answer, including the attachment list endpoint. */
function giteeFetch(entries: readonly { tag: string; asset: string; body?: string }[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/attach_files')) {
      return new Response(JSON.stringify([{ id: 1, title: 'Harness-CN_0.1.5-rc.9_x64-setup.exe', size: 4 }]), { status: 200 })
    }
    return new Response(JSON.stringify(entries.map(entry => ({
      id: 1,
      tag_name: entry.tag,
      body: entry.body ?? '',
      created_at: '2026-10-10T00:00:00Z',
      assets: [{
        name: entry.asset,
        size: 4,
        browser_download_url: `https://gitee.com/ph-wang/Harness-CN/releases/download/${entry.tag}/${entry.asset}`,
      }],
    }))), { status: 200 })
  }) as typeof globalThis.fetch
}

/** A GitHub-shaped answer for the same release, distinguishable by the download host. */
function githubFetch(entries: readonly { tag: string; asset: string; body?: string }[]): typeof globalThis.fetch {
  return (async () => new Response(githubReleases(entries), { status: 200 })) as typeof globalThis.fetch
}

describe('desktop release channel', () => {
  /** Scratch directory downloads are written into. */
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-cn-channel-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('asks Gitee before GitHub, because GitHub is the host that often does not answer here', async () => {
    const asked: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      asked.push(new URL(url).host)
      if (url.includes('gitee.com')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }) as typeof globalThis.fetch

    const channel = createReleaseChannel({ currentVersion: '0.1.5-rc.8', downloadDirectory: directory, fetch: fetchImpl })
    await channel.check().catch(() => undefined)

    expect(asked[0]).toBe('gitee.com')
    expect(asked).toContain('api.github.com')
  })

  it('offers the release the hosts publish as an installable version', async () => {
    const asset = 'Harness-CN_0.1.5-rc.9_x64-setup.exe'
    const channel = createReleaseChannel({
      currentVersion: '0.1.5-rc.8',
      downloadDirectory: directory,
      fetch: giteeFetch([{ tag: 'v0.1.5-rc.9', asset, body: '本版说明' }]),
    })

    await expect(channel.check()).resolves.toMatchObject({ version: '0.1.5-rc.9', notes: '本版说明' })
  })

  it('stays quiet when the running build is already the newest release', async () => {
    const channel = createReleaseChannel({
      currentVersion: '0.1.5-rc.9',
      downloadDirectory: directory,
      fetch: giteeFetch([{ tag: 'v0.1.5-rc.9', asset: 'Harness-CN_0.1.5-rc.9_x64-setup.exe' }]),
    })

    await expect(channel.check()).resolves.toBeUndefined()
  })

  it('takes the newest tag across hosts so a stale mirror cannot pin the build', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('gitee.com')) return giteeFetch([{ tag: 'v0.1.5-rc.8', asset: 'Harness-CN_0.1.5-rc.8_x64-setup.exe' }])(input)
      return githubFetch([{ tag: 'v0.1.5-rc.10', asset: 'Harness-CN_0.1.5-rc.10_x64-setup.exe' }])(input)
    }) as typeof globalThis.fetch

    const channel = createReleaseChannel({ currentVersion: '0.1.5-rc.8', downloadDirectory: directory, fetch: fetchImpl })

    await expect(channel.check()).resolves.toMatchObject({ version: '0.1.5-rc.10' })
  })

  it('skips a release that publishes no installer and keeps looking', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('gitee.com')) {
        return url.includes('/attach_files')
          ? new Response('[]', { status: 200 })
          : new Response(JSON.stringify([{ id: 1, tag_name: 'v0.2.0', created_at: '', body: '', assets: [] }]), { status: 200 })
      }
      return githubFetch([{ tag: 'v0.1.5-rc.10', asset: 'Harness-CN_0.1.5-rc.10_x64-setup.exe' }])(input)
    }) as typeof globalThis.fetch

    const channel = createReleaseChannel({ currentVersion: '0.1.5-rc.8', downloadDirectory: directory, fetch: fetchImpl })

    await expect(channel.check()).resolves.toMatchObject({ version: '0.1.5-rc.10' })
  })

  it('reports failure only when no host could be read', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof globalThis.fetch
    const channel = createReleaseChannel({ currentVersion: '0.1.5-rc.8', downloadDirectory: directory, fetch: fetchImpl })

    await expect(channel.check()).rejects.toThrow(/503/u)
  })

  it('refuses to download a version it never offered', async () => {
    const channel = createReleaseChannel({
      currentVersion: '0.1.5-rc.8',
      downloadDirectory: directory,
      fetch: giteeFetch([{ tag: 'v0.1.5-rc.9', asset: 'Harness-CN_0.1.5-rc.9_x64-setup.exe' }]),
    })
    await channel.check()

    await expect(channel.download({
      version: '0.1.5-rc.11',
      progress: () => {},
      bytes: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/offered release changed/u)
  })

  it('reports a cancelled download as cancelled and leaves nothing behind', async () => {
    const abort = new AbortController()
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // A body that starts arriving and then stops is what a user's cancel acts on. The stream is
      // ended by the abort, so the transfer cannot resolve after the cancellation.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason ?? new Error('aborted'))
          }, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': '1000' } })
    }) as typeof globalThis.fetch

    const pending = downloadVerified({
      directory,
      name: 'Harness-CN_0.1.5-rc.9_x64-setup.exe',
      url: 'https://gitee.com/ph-wang/Harness-CN/releases/download/v0.1.5-rc.9/installer.exe',
      sha256: '',
      signal: abort.signal,
      fetch: fetchImpl,
    })
    // The cancellation happens while the transfer is in flight, which is when a cancel arrives.
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort(new Error('the user cancelled the download'))

    await expect(pending).rejects.toThrow(new RegExp(UPDATE_CANCELLED, 'u'))
    await expect(readFile(join(directory, safeFileName('Harness-CN_0.1.5-rc.9_x64-setup.exe')))).rejects.toThrow()
  })

  it('deletes a download whose digest disagrees with the release', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([9, 9, 9, 9]), {
      status: 200,
      headers: { 'content-length': '4' },
    })) as typeof globalThis.fetch

    await expect(downloadVerified({
      directory,
      name: 'installer.exe',
      url: 'https://gitee.com/ph-wang/Harness-CN/releases/download/v0.1.5-rc.9/installer.exe',
      sha256: 'b'.repeat(64),
      fetch: fetchImpl,
    })).rejects.toThrow(/checksum mismatch/u)
    await expect(readFile(join(directory, 'installer.exe'))).rejects.toThrow()
  })

  it('reports every byte it wrote, so the window can show a moving bar', async () => {
    const sizes: number[] = []
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-length': '4' },
    })) as typeof globalThis.fetch

    const written = await downloadVerified({
      directory,
      name: 'installer.exe',
      url: 'https://gitee.com/ph-wang/Harness-CN/releases/download/v0.1.5-rc.9/installer.exe',
      sha256: '',
      bytes: (received) => { sizes.push(received) },
      fetch: fetchImpl,
    })

    expect(written.integrity).toBe('unverified')
    expect(written.bytes).toBe(4)
    expect(sizes.at(-1)).toBe(4)
  })
})
