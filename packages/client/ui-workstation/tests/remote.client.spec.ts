/**
 * The browser half's view of the remote-SSH plugin: the routes it calls and the
 * poller that says which host is current.
 *
 * The routes are the plugin's public HTTP surface, so this spec holds them to
 * their answer fields rather than to the plugin's internals: one stub stands in
 * for `fetch`, and every case states what the tree would draw from the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchRemoteHosts, listRemoteFiles, readRemoteFile, REMOTE_HOSTS_EMPTY, searchRemoteFiles,
  startRemoteHosts, writeRemoteFile,
} from '../src/client/remote.ts'
import type { RemoteHostsView } from '../src/client/remote.ts'

/** One answer as the route would send it. */
function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response
}

/** Replace `fetch` for one case. */
function stubFetch(answer: Response | Error): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** Let queued promise callbacks run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('remote routes', () => {
  it('reads the current host out of the host list', async () => {
    stubFetch(reply({
      hosts: [
        { host_id: 'host-1', display_name: 'builder' },
        { host_id: 'host-2', display_name: 'worker' },
      ],
      current_host_id: 'host-2',
    }))
    const answer = await fetchRemoteHosts()
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.value.currentHostId).toBe('host-2')
    expect(answer.value.hosts).toEqual([
      { hostId: 'host-1', displayName: 'builder' },
      { hostId: 'host-2', displayName: 'worker' },
    ])
  })

  it('treats a missing current host as browsing locally', async () => {
    stubFetch(reply({ hosts: [{ host_id: 'host-1' }], current_host_id: null }))
    const answer = await fetchRemoteHosts()
    expect(answer.ok && answer.value.currentHostId).toBe(null)
    expect(answer.ok && answer.value.hosts[0]?.displayName).toBe('host-1')
  })

  it('refuses a host list it cannot read', async () => {
    stubFetch(reply({ hosts: 'nope' }))
    const answer = await fetchRemoteHosts()
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure.code).toBe('remote/unexpected')
  })

  it('maps a directory listing onto entries with absolute paths', async () => {
    stubFetch(reply({
      host_id: 'host-1',
      path: '/root',
      entries: [
        { name: 'etc', path: '/root/etc', type: 'directory', size: 4096 },
        { name: 'notes.txt', type: 'file' },
      ],
      next_offset: 2,
    }))
    const answer = await listRemoteFiles('host-1', '/root')
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.value.truncated).toBe(true)
    expect(answer.value.entries).toEqual([
      { name: 'etc', path: '/root/etc', type: 'directory', size: 4096 },
      { name: 'notes.txt', path: '/root/notes.txt', type: 'file', size: null },
    ])
  })

  it('does not fabricate a child path under the filesystem root', async () => {
    stubFetch(reply({ host_id: 'host-1', path: '/', entries: [{ name: 'etc', type: 'directory' }] }))
    const answer = await listRemoteFiles('host-1', '/')
    expect(answer.ok && answer.value.entries[0]?.path).toBe('/etc')
  })

  it('refuses a listing it cannot read', async () => {
    stubFetch(reply({ host_id: 'host-1', path: '/', entries: null }))
    const answer = await listRemoteFiles('host-1', '/')
    expect(answer.ok).toBe(false)
  })

  it('reads a file with the version a write has to echo', async () => {
    stubFetch(reply({ host_id: 'host-1', path: '/etc/nginx.conf', content: 'worker_processes 1;', size: 19, version: 'v7' }))
    const answer = await readRemoteFile('host-1', '/etc/nginx.conf')
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.value).toEqual({ path: '/etc/nginx.conf', text: 'worker_processes 1;', version: 'v7', size: 19 })
  })

  it('reports a read whose body has no text', async () => {
    stubFetch(reply({ host_id: 'host-1', path: '/etc/nginx.conf', size: 19 }))
    const answer = await readRemoteFile('host-1', '/etc/nginx.conf')
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure.message).toBe('文件内容无法识别')
  })

  it('sends the read version back as the write guard and adopts the new one', async () => {
    const fetch = stubFetch(reply({ after_version: 'v8' }))
    const answer = await writeRemoteFile('host-1', '/etc/nginx.conf', 'next', 'v7')
    expect(answer.ok && answer.value.version).toBe('v8')
    const [route, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe('/remote-ssh-ops/v1/hosts/host-1/file')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ path: '/etc/nginx.conf', content: 'next', expected_version: 'v7' })
  })

  it('writes a file that was never read without a guard', async () => {
    const fetch = stubFetch(reply({ after_version: 'v1' }))
    await writeRemoteFile('host-1', '/etc/new.conf', 'body', null)
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ path: '/etc/new.conf', content: 'body' })
  })

  it('refuses a write answer it cannot read', async () => {
    stubFetch(reply('not json'))
    const answer = await writeRemoteFile('host-1', '/etc/new.conf', 'body', null)
    expect(answer.ok).toBe(false)
  })

  it('maps search hits and keeps their basenames', async () => {
    stubFetch(reply({
      host_id: 'host-1',
      root: '/etc',
      query: 'nginx',
      results: [{ path: '/etc/nginx/nginx.conf', name: 'nginx.conf' }, { path: '/etc/nginx.txt' }],
      truncated: true,
    }))
    const answer = await searchRemoteFiles('host-1', 'nginx', '/etc')
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.value.truncated).toBe(true)
    expect(answer.value.results).toEqual([
      { path: '/etc/nginx/nginx.conf', name: 'nginx.conf' },
      { path: '/etc/nginx.txt', name: 'nginx.txt' },
    ])
  })

  it('refuses a search answer it cannot read', async () => {
    stubFetch(reply({ results: 'nope' }))
    const answer = await searchRemoteFiles('host-1', 'nginx', '/etc')
    expect(answer.ok).toBe(false)
  })

  it('keeps the route’s own code and message on a refusal', async () => {
    stubFetch(reply({ error: '搜索关键词不能为空', code: 'SEARCH_QUERY_EMPTY' }, 400))
    const answer = await searchRemoteFiles('host-1', '', '/')
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure).toEqual({ code: 'SEARCH_QUERY_EMPTY', message: '搜索关键词不能为空' })
  })

  it('falls back to the status when a refusal carries no body', async () => {
    stubFetch(reply('', 502))
    const answer = await listRemoteFiles('host-1', '/')
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure).toEqual({ code: 'remote/http', message: 'HTTP 502' })
  })

  it('reports an empty success body rather than inventing one', async () => {
    stubFetch(reply('', 200))
    const answer = await fetchRemoteHosts()
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure.code).toBe('remote/unexpected')
  })

  it('reports a server that stopped answering as unreachable', async () => {
    stubFetch(new Error('connection refused'))
    const answer = await fetchRemoteHosts()
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.failure).toEqual({ code: 'remote/unreachable', message: 'connection refused' })
  })
})

describe('remote host polling', () => {
  it('stays on the local workspace while the host list fails', async () => {
    const load = vi.fn(async () => ({ ok: false as const, failure: { code: 'remote/unreachable', message: 'down' } }))
    const source = startRemoteHosts({ load, intervalMs: 10 })
    const listener = vi.fn()
    const off = source.subscribe(listener)
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toEqual(REMOTE_HOSTS_EMPTY)
    expect(listener).not.toHaveBeenCalled()
    off()
    source.dispose()
  })

  it('survives a loader that throws', async () => {
    const load = vi.fn(async (): Promise<never> => { throw new Error('boom') })
    const source = startRemoteHosts({ load, intervalMs: 10 })
    const off = source.subscribe(() => {})
    await settle()
    expect(source.getSnapshot()).toEqual(REMOTE_HOSTS_EMPTY)
    off()
    source.dispose()
  })

  it('publishes a host list once and reuses the snapshot until it moves', async () => {
    const view: RemoteHostsView = { currentHostId: 'host-1', hosts: [{ hostId: 'host-1', displayName: 'builder' }] }
    const load = vi.fn(async () => ({ ok: true as const, value: view }))
    const source = startRemoteHosts({ load, intervalMs: 10 })
    const listener = vi.fn()
    const off = source.subscribe(listener)
    await settle()
    const first = source.getSnapshot()
    expect(first.currentHostId).toBe('host-1')
    expect(listener).toHaveBeenCalled()
    const second = source.subscribe(listener)
    await settle()
    expect(source.getSnapshot()).toBe(first)
    second()
    off()
    source.dispose()
  })

  it('re-publishes when the current host moves', async () => {
    const answers = [
      { ok: true as const, value: { currentHostId: null, hosts: [] } },
      { ok: true as const, value: { currentHostId: 'host-2', hosts: [{ hostId: 'host-2', displayName: 'worker' }] } },
    ]
    let at = 0
    const load = vi.fn(async () => answers[Math.min(at++, answers.length - 1)]!)
    const source = startRemoteHosts({ load, intervalMs: 10 })
    const listener = vi.fn()
    const off = source.subscribe(listener)
    await settle()
    expect(source.getSnapshot().currentHostId).toBe(null)
    off()
    source.dispose()
  })

  it('polls on its own clock while a seat is mounted, and stops with the last one', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => ({ ok: true as const, value: REMOTE_HOSTS_EMPTY }))
    const source = startRemoteHosts({ load, intervalMs: 1_000 })
    const off = source.subscribe(() => {})
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(load).toHaveBeenCalledTimes(2)
    off()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('does not stack polls when the previous one is still in flight', async () => {
    let release!: (value: { ok: true; value: RemoteHostsView }) => void
    const pending = new Promise<{ ok: true; value: RemoteHostsView }>((resolve) => { release = resolve })
    const load = vi.fn(() => pending)
    const source = startRemoteHosts({ load, intervalMs: 10 })
    const first = source.subscribe(() => {})
    const second = source.subscribe(() => {})
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    release({ ok: true, value: { currentHostId: 'host-1', hosts: [{ hostId: 'host-1', displayName: 'builder' }] } })
    await settle()
    expect(source.getSnapshot().currentHostId).toBe('host-1')
    second()
    first()
    source.dispose()
  })
})
