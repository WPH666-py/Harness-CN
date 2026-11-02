/**
 * Repaint the dsh-plugin-rea setup guide from a dark card to a light one.
 *
 * WHY THIS IS NOT CONFIGURATION. The guide's `client.js` hardcodes a dark palette in three inline
 * style objects: the card reads `var(--dsw-alias-bg-elevated, #171a20)` with `#e9e9e9` text, the
 * command block `rgba(255,255,255,0.06)`, and the primary button `var(--dsw-alias-label-brand,
 * #4f8cff)` with white text. In this product the panel is drawn inside a light window, so the
 * fallbacks win and the guide lands as a black modal with a saturated blue button on a white page.
 * The package exposes no theme hook for it — `dsh.bundle.patch` adds composition entries, not
 * markup — so the fix belongs in the bytes this product's seed ships.
 *
 * The replacements keep the layout and text untouched and only swap the palette: a white card with
 * a hairline border, near-black text, a light grey command block, and a pale blue primary button
 * with blue text. Each edit is an exact block replacement; a bundle that lost an anchor fails loudly
 * instead of shipping a half-painted guide.
 *
 *   node scripts/patch-rea-guide-theme.mjs <node_modules directory>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package that owns the guide. */
const PACKAGE = 'dsh-plugin-rea'
/** Client bundle the Web host loads for that package. */
const BUNDLE = 'client.js'

/** Marker the patched file must end up carrying. */
const MARKER = '/* rea-guide: light palette */'

/** Blocks replaced, each as [anchor, replacement]. */
const EDITS = [
  [
    `    const maskStyle = {
      position: "fixed",
      inset: 0,
      zIndex: 2400,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      background: "rgba(6, 8, 12, 0.55)",
      pointerEvents: "auto",
    };`,
    `    const maskStyle = {
      position: "fixed",
      inset: 0,
      zIndex: 2400,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      background: "rgba(15, 23, 42, 0.32)",
      pointerEvents: "auto",
    };`,
  ],
  [
    `    const cardStyle = {
      width: "min(620px, 100%)",
      maxHeight: "82vh",
      overflow: "auto",
      padding: "22px 24px 18px",
      borderRadius: 14,
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.14))",
      background: "var(--dsw-alias-bg-elevated, #171a20)",
      color: "var(--dsw-alias-label-primary, #e9e9e9)",
      boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
      lineHeight: 1.6,
      fontSize: 14,
    };`,
    `    const cardStyle = {
      width: "min(620px, 100%)",
      maxHeight: "82vh",
      overflow: "auto",
      padding: "22px 24px 18px",
      borderRadius: 14,
      border: "1px solid #d8dee4",
      background: "#ffffff",
      color: "#1f2328",
      boxShadow: "0 18px 48px rgba(15, 23, 42, 0.18)",
      lineHeight: 1.6,
      fontSize: 14,
    };`,
  ],
  [
    `    const codeStyle = {
      margin: "10px 0 0",
      padding: "10px 12px",
      borderRadius: 9,
      background: "var(--dsw-alias-bg-secondary, rgba(255,255,255,0.06))",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.10))",`,
    `    const codeStyle = {
      margin: "10px 0 0",
      padding: "10px 12px",
      borderRadius: 9,
      background: "#f6f8fa",
      color: "#3d4451",
      border: "1px solid #e1e4e8",`,
  ],
  [
    `    const buttonBase = {
      appearance: "none",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.18))",
      background: "transparent",
      color: "inherit",`,
    `    const buttonBase = {
      appearance: "none",
      border: "1px solid #d0d7de",
      background: "#f6f8fa",
      color: "inherit",`,
  ],
  [
    `    const primaryButton = Object.assign({}, buttonBase, {
      background: "var(--dsw-alias-label-brand, #4f8cff)",
      borderColor: "var(--dsw-alias-label-brand, #4f8cff)",
      color: "#fff",
      fontWeight: 600,
    });`,
    `    const primaryButton = Object.assign({}, buttonBase, {
      background: "#dbeafe",
      borderColor: "#bfdbfe",
      color: "#1d4ed8",
      fontWeight: 600,
    });`,
  ],
]

const argumentsList = process.argv.slice(2)
const root = argumentsList[0]
if (!root) {
  console.error('usage: node scripts/patch-rea-guide-theme.mjs <node_modules directory>')
  process.exit(2)
}

const file = join(root, PACKAGE, BUNDLE)
if (!existsSync(file)) {
  console.error(`patch-rea-guide-theme: no ${PACKAGE} under ${root}; nothing to patch`)
  process.exit(0)
}

let text = readFileSync(file, 'utf8')
if (text.includes(MARKER)) {
  console.log(`patch-rea-guide-theme: already patched ${file}`)
  process.exit(0)
}

for (const [anchor, replacement] of EDITS) {
  if (!text.includes(anchor)) {
    console.error(`patch-rea-guide-theme: anchor missing in ${file}; refusing to ship a half-painted guide`)
    process.exit(1)
  }
  text = text.replace(anchor, `${MARKER}\n${replacement}`)
}

writeFileSync(file, text)
const digest = createHash('sha256').update(text).digest('hex')
console.log(`patch-rea-guide-theme: patched ${file} (${Buffer.byteLength(text)} bytes, sha256 ${digest.slice(0, 8)})`)
