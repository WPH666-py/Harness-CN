/**
 * Publish one Harness-CN release to GitHub and Gitee.
 *
 * Both hosts are published from the same source of truth — the same files and the same body of
 * release notes — so a user who can only reach one of them gets the same version, the same notes,
 * and byte-identical downloads. A release carries two files: the installer, and the offline package
 * the first launch fetches. Gitee caps an attachment at 100 MB, which is the constraint both are
 * sized against; this script refuses an upload that would fail there rather than leaving a release
 * that reports a version nobody can download.
 *
 * Idempotent: an existing release for the tag is reused, and an asset whose name is already
 * published is compared by size and left alone when it matches.
 *
 * The repositories come from the environment so this runs from a workflow rather than from one
 * maintainer's checkout; the defaults are the two this product publishes to.
 *
 *   GH_TOKEN=... GITEE_TOKEN=... \
 *   node scripts/release/publish-harness-cn.mjs <version> <notes-file> <asset> [<asset>...]
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const GITHUB_REPOSITORY = process.env.HARNESS_CN_GITHUB_REPOSITORY ?? 'WPH666-py/Harness-CN'
const GITEE_REPOSITORY = process.env.HARNESS_CN_GITEE_REPOSITORY ?? 'ph-wang/Harness-CN'
const GITEE_ATTACHMENT_LIMIT = 100 * 1024 * 1024

const [version, notesArgument, ...assetArguments] = process.argv.slice(2)
if (version === undefined || notesArgument === undefined || assetArguments.length === 0) {
  throw new Error('usage: node publish-harness-cn.mjs <version> <notes-file> <asset> [<asset>...]')
}
const notes = (await readFile(resolve(notesArgument), 'utf8')).trim()
const tag = `v${version}`

const assets = []
for (const argument of assetArguments) {
  const path = resolve(argument)
  const bytes = await stat(path)
  const digest = createHash('sha256').update(await readFile(path)).digest('hex')
  assets.push({ path, name: basename(path), size: bytes.size, digest })
}

console.log(`publishing ${tag} to ${GITHUB_REPOSITORY} and ${GITEE_REPOSITORY}`)
for (const asset of assets) {
  console.log(`  asset    ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`)
  console.log(`  sha256   ${asset.digest.toUpperCase()}`)
  if (asset.size > GITEE_ATTACHMENT_LIMIT) {
    throw new Error(
      `${asset.name} is ${(asset.size / 1024 / 1024).toFixed(1)} MB and Gitee caps an attachment at 100 MB`,
    )
  }
}

const githubToken = process.env.GH_TOKEN
const giteeToken = process.env.GITEE_TOKEN
if (githubToken === undefined || giteeToken === undefined) {
  throw new Error('GH_TOKEN and GITEE_TOKEN must both be set')
}

/** One request that either answers or explains itself. */
async function request(url, init, expected) {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!expected.includes(response.status)) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${String(response.status)} ${response.statusText}\n${text.slice(0, 600)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// --- GitHub ------------------------------------------------------------------
//
// The release body is sent as UTF-8 bytes rather than as a string: the notes are Chinese, and a
// body handed over as a plain string has silently been written as Latin-1 on this API before.

const githubHeaders = {
  authorization: `token ${githubToken}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'Harness-CN-release',
  'content-type': 'application/json; charset=utf-8',
}

let githubRelease
try {
  githubRelease = await request(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${tag}`,
    { headers: githubHeaders },
    [200],
  )
  console.log(`  github   release ${tag} already exists (id ${String(githubRelease.id)})`)
} catch {
  githubRelease = await request(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases`,
    {
      method: 'POST',
      headers: githubHeaders,
      body: Buffer.from(JSON.stringify({
        tag_name: tag,
        name: `Harness-CN ${version}`,
        body: notes,
        draft: false,
        prerelease: version.includes('-'),
      }), 'utf8'),
    },
    [201],
  )
  console.log(`  github   created release ${tag} (id ${String(githubRelease.id)})`)
}

for (const asset of assets) {
  const existing = (githubRelease.assets ?? []).find(candidate => candidate.name === asset.name)
  if (existing !== undefined && existing.size === asset.size) {
    console.log(`  github   ${asset.name} already published at the same size; left alone`)
    continue
  }
  if (existing !== undefined) {
    await request(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/assets/${String(existing.id)}`,
      { method: 'DELETE', headers: githubHeaders },
      [204],
    )
    console.log('  github   removed the previous asset of the same name')
  }
  const uploaded = await request(
    `https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${String(githubRelease.id)}/assets?name=${encodeURIComponent(asset.name)}`,
    {
      method: 'POST',
      headers: {
        authorization: `token ${githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'Harness-CN-release',
        'content-type': 'application/octet-stream',
      },
      body: await readFile(asset.path),
    },
    [201],
  )
  console.log(`  github   uploaded ${asset.name} (${String(uploaded.size)} bytes, ${String(uploaded.digest ?? 'no digest')})`)
}

// --- Gitee -------------------------------------------------------------------
//
// Gitee takes form fields rather than JSON for release creation, and an attachment goes up as
// multipart. It answers with no digest, which is why the release notes publish the sha256 the user
// can check by hand.

const giteeBase = `https://gitee.com/api/v5/repos/${GITEE_REPOSITORY}`
const giteeReleases = await request(`${giteeBase}/releases?access_token=${giteeToken}&per_page=100`, {}, [200])
let giteeRelease = giteeReleases.find(release => release.tag_name === tag)
if (giteeRelease === undefined) {
  giteeRelease = await request(`${giteeBase}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      access_token: giteeToken,
      tag_name: tag,
      name: `Harness-CN ${version}`,
      body: notes,
      target_commitish: 'main',
      prerelease: String(version.includes('-')),
    }),
  }, [201])
  console.log(`  gitee    created release ${tag} (id ${String(giteeRelease.id)})`)
} else {
  console.log(`  gitee    release ${tag} already exists (id ${String(giteeRelease.id)})`)
}

const attachments = await request(
  `${giteeBase}/releases/${String(giteeRelease.id)}/attach_files?access_token=${giteeToken}`,
  {},
  [200],
)
for (const asset of assets) {
  const existing = (Array.isArray(attachments) ? attachments : [])
    .filter(file => (file.title ?? file.name) === asset.name)
  if (existing.some(file => file.size === asset.size)) {
    console.log(`  gitee    ${asset.name} already published at the same size; left alone`)
    continue
  }
  // Every same-named attachment goes, not just one: Gitee keeps them side by side rather than
  // replacing, and it serves whichever it lists first, so leaving an older copy behind means the
  // release page can hand out a build that was already replaced.
  for (const file of existing) {
    const id = file.id
    if (id === undefined) continue
    await request(
      `${giteeBase}/releases/${String(giteeRelease.id)}/attach_files/${String(id)}?access_token=${giteeToken}`,
      { method: 'DELETE' },
      [204],
    )
    console.log(`  gitee    removed attachment ${String(id)} (${String(file.size)} bytes)`)
  }
  const form = new FormData()
  form.append('access_token', giteeToken)
  form.append('file', new Blob([await readFile(asset.path)]), asset.name)
  const uploaded = await request(
    `${giteeBase}/releases/${String(giteeRelease.id)}/attach_files`,
    { method: 'POST', body: form },
    [201],
  )
  console.log(`  gitee    uploaded ${asset.name} (${String(uploaded.size ?? asset.size)} bytes)`)
}

console.log('')
console.log(`GitHub  https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`)
console.log(`Gitee   https://gitee.com/${GITEE_REPOSITORY}/releases/tag/${tag}`)
