/**
 * Split a release asset into host-sized parts, for a host that caps one attachment.
 *
 * Gitee refuses an attachment over 100 MB while GitHub does not, so the Harness-CN release process
 * publishes the offline package whole on GitHub and as fixed-size parts on Gitee. The parts are a
 * byte-for-byte cut of the archive: concatenating them in name order restores it exactly, which the
 * plain-text manifest written beside them states together with every digest.
 *
 *   node scripts/release/split-offline-package.mjs --version 0.1.5-rc.27
 *   node scripts/release/split-offline-package.mjs --asset <path> --out <dir> --part-mib 64
 *
 * Defaults: the offline package of `--version` under
 * `apps/desktop-shell/dist-artifacts`, parts of 64 MiB, output beside the parts directory given by
 * `--out` (default `dist-artifacts/parts`).
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    asset: { type: 'string' },
    out: { type: 'string' },
    'part-mib': { type: 'string' },
  },
})

/** The repository root, two directories above this script. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const asset = values.asset
  ?? (values.version === undefined
    ? undefined
    : join(REPO_ROOT, 'apps', 'desktop-shell', 'dist-artifacts', `Harness-CN-seed-${values.version}.tar.zst`))
if (asset === undefined) throw new Error('usage: split-offline-package.mjs <--version x.y.z | --asset <path>> [--out <dir>] [--part-mib 64]')

const outDir = values.out ?? join(dirname(asset), 'parts')
const partBytes = Math.round(Number(values['part-mib'] ?? '64') * 1024 * 1024)
if (!Number.isFinite(partBytes) || partBytes <= 0) throw new Error(`--part-mib must be a positive number, got ${String(values['part-mib'])}`)

const name = basename(asset)
const total = (await stat(asset)).size
const count = Math.ceil(total / partBytes)
await mkdir(outDir, { recursive: true })

const handle = await open(asset, 'r')
const buffer = Buffer.alloc(4 * 1024 * 1024)
const parts = []
let offset = 0
for (let index = 0; index < count; index += 1) {
  const partName = `${name}.part${String(index + 1)}of${String(count)}`
  const path = join(outDir, partName)
  const target = Math.min(partBytes, total - offset)
  const sink = createWriteStream(path)
  const hash = createHash('sha256')
  let written = 0
  while (written < target) {
    const want = Math.min(buffer.length, target - written)
    const { bytesRead } = await handle.read(buffer, 0, want, offset + written)
    if (bytesRead === 0) throw new Error(`unexpected end of ${name} at ${String(offset + written)}`)
    sink.write(buffer.subarray(0, bytesRead))
    hash.update(buffer.subarray(0, bytesRead))
    written += bytesRead
  }
  sink.end()
  await once(sink, 'close')
  parts.push({ partName, bytes: written, sha256: hash.digest('hex') })
  offset += written
  console.log(`${partName}  ${String(written)} bytes  sha256=${parts.at(-1)?.sha256 ?? ''}`)
}
await handle.close()

const whole = createHash('sha256')
for await (const chunk of createReadStream(asset)) whole.update(chunk)
const digest = whole.digest('hex')

const reassemble = [`Get-Content -AsByteStream ${parts.map(part => part.partName).join(', ')} | Set-Content -AsByteStream ${name}`]
const lines = [
  `# ${name} — split into ${String(count)} part(s) for a host that caps one attachment`,
  '',
  `The released archive is ${name} (${String(total)} bytes, sha256 ${digest}).`,
  'Concatenate the parts in the order listed below to restore it byte for byte.',
  '',
  '## Parts',
  '',
  ...parts.map((part, index) => `- ${String(index + 1)}. ${part.partName} — ${String(part.bytes)} bytes, sha256 ${part.sha256}`),
  '',
  '## Reassemble',
  '',
  '```powershell',
  ...reassemble,
  '```',
  '',
  '```sh',
  `cat ${parts.map(part => part.partName).join(' ')} > ${name}`,
  '```',
  '',
  `The result must be ${String(total)} bytes with sha256 ${digest}.`,
  '',
]
const manifest = join(outDir, `${name}.parts.txt`)
await writeFile(manifest, lines.join('\n'), 'utf8')
console.log(`manifest ${manifest}`)
console.log(`whole ${String(total)} bytes sha256=${digest}`)
