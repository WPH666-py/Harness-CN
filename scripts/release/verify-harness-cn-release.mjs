/**
 * Verify a published Harness-CN release by downloading it back from both hosts.
 *
 * Publishing is not the same act as being downloadable: an upload can be truncated, a host can serve
 * a stale attachment of the same name, and Gitee keeps duplicates side by side rather than
 * replacing. This reads the published file back from GitHub and from Gitee and compares it with the
 * bytes this machine produced, which is the only check that covers either host's failure mode.
 *
 *   GH_TOKEN=... GITEE_TOKEN=... \
 *   node scripts/release/verify-harness-cn-release.mjs <version> <directory-of-assets>
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const GITHUB_REPOSITORY = process.env.HARNESS_CN_GITHUB_REPOSITORY ?? 'WPH666-py/Harness-CN'
const GITEE_REPOSITORY = process.env.HARNESS_CN_GITEE_REPOSITORY ?? 'ph-wang/Harness-CN'
const USER_AGENT = 'Harness-CN-verify'

const [version, directory] = process.argv.slice(2)
if (version === undefined || directory === undefined) {
  throw new Error('usage: node verify-harness-cn-release.mjs <version> <directory-of-assets>')
}
const tag = `v${version}`
const githubToken = process.env.GH_TOKEN
const giteeToken = process.env.GITEE_TOKEN
if (githubToken === undefined || giteeToken === undefined) {
  throw new Error('GH_TOKEN and GITEE_TOKEN must both be set')
}

/** Every published asset in one directory, as name plus digest of the local bytes. */
async function localAssets() {
  const found = []
  for (const name of await readdir(resolve(directory))) {
    if (!name.endsWith('.exe') && !name.endsWith('.tar.zst')) continue
    const path = resolve(directory, name)
    found.push({
      name,
      bytes: (await stat(path)).size,
      digest: createHash('sha256').update(await readFile(path)).digest('hex'),
    })
  }
  if (found.length === 0) throw new Error(`no release assets in ${directory}`)
  return found
}

/** Download one address and describe the bytes that arrived. */
async function describeDownload(url, headers) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} -> ${String(response.status)} ${response.statusText}`)
  const body = Buffer.from(await response.arrayBuffer())
  return { bytes: body.byteLength, digest: createHash('sha256').update(body).digest('hex') }
}

/**
 * Download one GitHub asset, preferring the address the release page hands out.
 *
 * A machine that reaches the GitHub API does not necessarily reach its asset CDN — the two are
 * different hosts and different addresses — so a failed download falls back to the API's own asset
 * endpoint, which serves the same bytes over the host that has already answered.
 * @param asset - asset record from the release.
 * @returns the bytes that arrived, and a name for where they came from.
 */
async function downloadGithubAsset(asset) {
  const headers = { authorization: `token ${githubToken}`, accept: 'application/octet-stream' }
  try {
    return { source: 'browser url', ...(await describeDownload(asset.browser_download_url, headers)) }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    console.log(`github    ${asset.browser_download_url} failed (${note}); retrying through the API`)
  }
  return {
    source: 'api url',
    ...(await describeDownload(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/assets/${String(asset.id)}`, headers)),
  }
}

const assets = await localAssets()
let failures = 0

for (const asset of assets) {
  console.log(`\n=== ${asset.name} ===`)
  console.log(`local     ${String(asset.bytes)} bytes  ${asset.digest}`)

  const githubRelease = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${tag}`,
    { headers: { authorization: `token ${githubToken}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT } },
  ).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub release ${tag} -> ${String(response.status)}`)
    return await response.json()
  })
  const githubAsset = (githubRelease.assets ?? []).find(candidate => candidate.name === asset.name)
  if (githubAsset === undefined) {
    console.log('github    MISSING from the release')
    failures += 1
  } else {
    const published = await downloadGithubAsset(githubAsset)
    const same = published.bytes === asset.bytes && published.digest === asset.digest
    console.log(`github    ${String(published.bytes)} bytes  ${published.digest}  ${same ? 'OK' : 'MISMATCH'} (${published.source})`)
    if (!same) failures += 1
  }

  // Gitee serves whichever same-named attachment it lists first, so the check asks the API which
  // file is listed and then downloads exactly that URL rather than guessing at a path.
  const giteeBase = `https://gitee.com/api/v5/repos/${GITEE_REPOSITORY}`
  const releases = await fetch(`${giteeBase}/releases?access_token=${giteeToken}&per_page=100`, {
    headers: { 'user-agent': USER_AGENT },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Gitee releases -> ${String(response.status)}`)
    return await response.json()
  })
  const release = releases.find(candidate => candidate.tag_name === tag)
  if (release === undefined) {
    console.log('gitee     MISSING release')
    failures += 1
  } else {
    const files = await fetch(`${giteeBase}/releases/${String(release.id)}/attach_files?access_token=${giteeToken}`, {
      headers: { 'user-agent': USER_AGENT },
    }).then(async (response) => await response.json())
    const listed = (Array.isArray(files) ? files : []).filter(file => (file.title ?? file.name) === asset.name)
    if (listed.length === 0) {
      console.log('gitee     MISSING attachment')
      failures += 1
    }
    if (listed.length > 1) {
      // Not a failure by itself, but the reason this product deletes same-named attachments before
      // uploading: the release page can hand out the older one.
      console.log(`gitee     ${String(listed.length)} attachments share this name; the download below is the first`)
    }
    for (const file of listed) {
      const url = file.download_url ?? file.browser_download_url
        ?? `${giteeBase}/releases/${String(release.id)}/attach_files/${String(file.id)}/download`
      const published = await describeDownload(url, {})
      const same = published.bytes === asset.bytes && published.digest === asset.digest
      console.log(`gitee     ${String(published.bytes)} bytes  ${published.digest}  ${same ? 'OK' : 'MISMATCH'}`)
      if (!same) failures += 1
    }
  }
}

console.log('')
if (failures > 0) {
  console.error(`${String(failures)} published file(s) do not match the bytes this machine produced`)
  process.exitCode = 1
} else {
  console.log('ALL OK')
}
