/**
 * Seed the preview-notice acknowledgement into every profile built from this seed.
 *
 * `@deepseek-ai/dsh-client-ui-settings-models` opens 「预览版说明」 until the settings value
 * `ui-settings-general.welcomeNoticeVersion` equals the version that notice was written for. The
 * value lives in the profile's own patch layer, `<profile>/cordis.patch.yml`, which a first launch
 * has not written yet, so the notice always opened on a fresh install. The seed now carries that
 * file, and `copyMetadata` in `src/project-manager.ts` copies it into every materialized profile.
 *
 * Seeding an acknowledgement is not the same as deleting the notice: a later notice ships a new
 * version string that no longer matches the seeded one, so the notice appears once and the settings
 * editor writes the new acknowledgement into the same row.
 *
 * Values are read from the client package's own source so this script cannot invent a version the
 * client would ignore.
 *
 * Usage: node scripts/seed-welcome-ack.mjs <seed-root> [--check]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

const PATCH = 'welcome-ack'
const PATCH_FILE = 'cordis.patch.yml'
const SETTINGS_ENTRY_ID = 'ui-settings-general'
const SETTINGS_ENTRY_NAME = '@deepseek-ai/dsh-client-ui-settings-general'
const ACK_FIELD = 'welcomeNoticeVersion'
const ACK_VERSION_NAME = 'WELCOME_NOTICE_VERSION'
const COPY_SOURCE = resolve(
  import.meta.dirname, '..', '..', '..',
  'packages', 'client', 'ui-settings-models', 'src', 'onboarding-copy.ts',
)

/** Read one exported string constant of the client's onboarding-copy module. */
function readConstant(source, name) {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(source)
  if (match === null) {
    throw new Error(`desktop seed: ${COPY_SOURCE} no longer declares ${name}`)
  }
  return match[1]
}

/** Version string the shipped client compares the acknowledgement against. */
function acknowledgedVersion() {
  return readConstant(readFileSync(COPY_SOURCE, 'utf8'), ACK_VERSION_NAME)
}

function renderPatch(version) {
  return [
    '# Profile patch layer contributed by apps/desktop/scripts/seed-welcome-ack.mjs.',
    '#',
    '# A profile built from this seed starts with the preview notice acknowledged for the version',
    '# below, so a first launch opens straight into the workspace. The settings editor rewrites this',
    '# same row when the notice changes or a person acknowledges it, so it never stacks a duplicate.',
    `- id: ${SETTINGS_ENTRY_ID}`,
    `  name: '${SETTINGS_ENTRY_NAME}'`,
    '  config:',
    `    ${ACK_FIELD}: '${version}'`,
    '',
  ].join('\n')
}

/**
 * Write the acknowledgement into the seed's profile patch, or report that it is already there.
 * @param root - directory the seed is assembled in.
 * @returns one line describing what happened.
 */
export function seedWelcomeAcknowledgement(root) {
  const version = acknowledgedVersion()
  const target = join(root, PATCH_FILE)
  const row = `${ACK_FIELD}: '${version}'`
  if (existsSync(target)) {
    const source = readFileSync(target, 'utf8')
    if (source.includes(row)) return `already acknowledged in ${target}`
    throw new Error(`desktop seed: ${target} exists without the ${ACK_FIELD} row for ${version}`)
  }
  const rendered = renderPatch(version)
  writeFileSync(target, rendered)
  const digest = createHash('sha256').update(rendered).digest('hex').slice(0, 16)
  return `wrote ${target} (${ACK_FIELD} ${version}, sha256 ${digest})`
}

/**
 * Fail when a seed tree does not acknowledge the shipped notice.
 * @param root - seed directory, or the assembled seed output directory.
 */
export function verifyWelcomeAcknowledgement(root) {
  const version = acknowledgedVersion()
  const target = join(root, PATCH_FILE)
  if (!existsSync(target)) {
    throw new Error(`desktop seed: ${target} is missing the preview-notice acknowledgement`)
  }
  const source = readFileSync(target, 'utf8')
  if (!source.includes(`${ACK_FIELD}: '${version}'`)) {
    throw new Error(`desktop seed: ${target} does not acknowledge the preview notice ${version}`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2))
  if (options.root === undefined) {
    report(PATCH, '', 'drifted', 'usage: node scripts/seed-welcome-ack.mjs <seed-root> [--check]')
  } else if (options.check) {
    try {
      verifyWelcomeAcknowledgement(options.root)
      report(PATCH, options.root, 'patched', `acknowledges ${acknowledgedVersion()}`)
    } catch (error) {
      report(PATCH, options.root, 'drifted', error instanceof Error ? error.message : String(error))
    }
  } else {
    try {
      report(PATCH, options.root, 'patched', seedWelcomeAcknowledgement(options.root))
    } catch (error) {
      report(PATCH, options.root, 'drifted', error instanceof Error ? error.message : String(error))
    }
  }
}
