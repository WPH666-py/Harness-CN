/**
 * Replace the controller data-directory lock with an operating-system lease.
 *
 * The plugin records `{ pid }` in `.controller.lock` and treats `process.kill(pid, 0)` as proof that
 * the writer is alive. A PID is not an identity: after the Host crashes, Windows can hand the same
 * number to an unrelated process (on this machine a `quark` process had inherited the recorded PID),
 * the liveness check then passes forever, `apply()` throws `DATA_DIR_IN_USE` on every start, and the
 * plugin's routes never serve until someone deletes the file by hand.
 *
 * The replacement below makes the lease the operating system's own: a named pipe (a bound socket
 * file on POSIX) can be owned by exactly one process and is released when that process exits, so a
 * crash can never leave the directory locked. A leftover PID file is removed and reported at the next
 * start, which is also where a human would look after reading the old error message.
 *
 * Like the other patches here, this edits installed bytes of a third-party package during the seed
 * build; the file is plain ESM source and is what Node actually loads.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The lock module, relative to the package. */
const SOURCE = join('dsh-remote-ssh-ops', 'src', 'controller', 'data-dir-lock.js')

/** Present only in the replacement; also the signal that the patch already applied. */
const MARKER = 'leaseTarget'

/** Anchor of the PID-file implementation, so a rewritten upstream module reports drift. */
const LEGACY = 'function processAlive(pid)'

/** Placeholder for the Windows pipe prefix; substituted with a JSON string literal below. */
const PIPE_PLACEHOLDER = '__WINDOWS_PIPE_PREFIX__'

/**
 * The replacement module.
 *
 * Kept as one template so the whole file can be replaced: the patch must not leave half of the old
 * PID logic behind, because the two mechanisms disagree about what "locked" means.
 */
const REPLACEMENT = `/**
 * One owner per controller data directory, enforced by the operating system.
 *
 * The lease is a named pipe (a bound socket file on POSIX): only one process can own it, and the
 * operating system releases it when that process exits. A PID recorded in a file cannot make that
 * promise — a crashed writer's number can be handed to an unrelated process, which then looks like
 * a live owner forever.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const LOCK_FILE = '.controller.lock'
const LOCK_SOCKET = '.controller.lock.sock'
const PIPE_PREFIX = ${PIPE_PLACEHOLDER}

function dataDirInUse(lockPath) {
  const error = new Error('远程主机数据目录已被另一个 DSH 进程使用：' + lockPath)
  error.code = 'DATA_DIR_IN_USE'
  return error
}

function leaseTarget(dataDir) {
  if (process.platform !== 'win32') return path.join(dataDir, LOCK_SOCKET)
  const digest = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24)
  return path.join(PIPE_PREFIX, 'dsh-remote-ssh-ops-' + digest)
}

function listen(server, target) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen({ path: target, exclusive: true }, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

function connected(target) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(target)
    socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
    socket.once('error', () => { socket.destroy(); resolvePromise(false) })
  })
}

async function acquireLease(target) {
  const server = net.createServer((socket) => socket.destroy())
  try {
    await listen(server, target)
    return server
  } catch (error) {
    server.close()
    if (error?.code !== 'EADDRINUSE') throw error
  }
  // A POSIX socket file outlives its process; a refused connection proves nobody is listening.
  if (process.platform !== 'win32' && !(await connected(target))) {
    await unlink(target).catch(() => {})
    const retry = net.createServer((socket) => socket.destroy())
    try {
      await listen(retry, target)
      return retry
    } catch (error) {
      retry.close()
      if (error?.code === 'EADDRINUSE') throw dataDirInUse(target)
      throw error
    }
  }
  throw dataDirInUse(target)
}

// 锁住完整控制器目录，避免多进程用各自内存快照覆盖主机记录。
export async function acquireDataDirLock(dataDir) {
  await mkdir(dataDir, { recursive: true })
  const target = leaseTarget(dataDir)
  const server = await acquireLease(target)
  const legacy = path.join(dataDir, LOCK_FILE)
  if (existsSync(legacy)) {
    // The file cannot block anything any more. Removing it keeps its stale PID from sending the
    // next investigation after a process that has nothing to do with this directory.
    await unlink(legacy).catch(() => {})
    console.warn('[remote-ssh-ops] reclaimed the remote host data directory lease; removed the lock file left by a previous Host process')
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await new Promise((resolvePromise) => { server.close(() => resolvePromise()) })
    if (process.platform !== 'win32') await unlink(target).catch(() => {})
  }
}
`

/**
 * The replacement text, with the Windows pipe prefix spliced in as a valid string literal.
 * @returns the module source to install.
 */
function replacementSource() {
  return REPLACEMENT.replace(PIPE_PLACEHOLDER, JSON.stringify('\\\\.\\pipe'))
}

/**
 * Install the lease implementation in an installed plugin tree.
 * @param nodeModules - the profile's node_modules directory.
 * @returns the file this call rewrote.
 * @throws When the file exists but carries neither the PID implementation nor the lease, because
 * that means upstream changed and the patch would stop applying without saying so.
 */
export function patchRemoteSshDataLock(nodeModules) {
  const file = join(nodeModules, SOURCE)
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (text.includes(MARKER)) return []
  if (!text.includes(LEGACY)) {
    throw new Error(`${file} carries neither the PID lock nor the lease; the data-directory lock patch no longer applies`)
  }
  writeFileSync(file, replacementSource(), 'utf8')
  return [file]
}

/**
 * Require the lease implementation in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 * @returns the patched file.
 * @throws When the archived package still records a PID instead of holding a lease.
 */
export function verifyRemoteSshDataLock(tree) {
  const file = join(tree, SOURCE)
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (!text.includes(MARKER) || text.includes(LEGACY)) {
    throw new Error(`desktop seed: ${file} still uses the PID lock that a crashed Host never releases`)
  }
  return [file]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-data-lock.mjs [--check] <node_modules>')
    process.exit(2)
  }
  const file = join(root, SOURCE)
  if (!existsSync(file)) report('remote-ssh-data-lock', root, 'absent', SOURCE)
  if (check) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(MARKER)) report('remote-ssh-data-lock', root, 'patched', file)
    if (text.includes(LEGACY)) report('remote-ssh-data-lock', root, 'pristine', file)
    report('remote-ssh-data-lock', root, 'drifted', `${file} carries neither implementation`)
  }
  const changed = patchRemoteSshDataLock(root)
  verifyRemoteSshDataLock(root)
  console.log(`remote-ssh data-directory lock: ${String(changed.length)} file(s) updated`)
}
