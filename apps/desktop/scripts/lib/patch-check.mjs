/**
 * Shared `--check` reporting for the seed patch scripts.
 *
 * Every patch in this directory edits bytes of a *third-party* package, so it can only work while the
 * text it anchors on still exists. When an upstream upgrade rewrites that text, the patch either
 * throws (loud) or silently skips (quiet) — and the quiet case is the one that ships a broken feature
 * because nothing in the build log says the patch stopped applying. `--check` gives every script the
 * same voice for that condition: one JSON line on stdout, `state: 'drifted'` meaning "the anchor is
 * gone, this patch will not apply any more".
 *
 * States:
 *   absent    the target package is not installed in this tree; nothing to check, nothing to fail.
 *   patched   the tree already carries the patch (a re-application is a no-op).
 *   pristine  the original bytes are present and the anchor is intact — applying would change it.
 *   drifted   the file exists but neither the original anchor nor the patch is there.
 *
 * A caller that expects the patch to be applied treats `drifted` as a failure; one that inspects a
 * fresh tree treats `pristine` as healthy and `patched` as already done.
 */

/**
 * Print one check result and exit.
 *
 * The process exits with 1 for `drifted` so a bare `node patch-….mjs --check <tree>` in a shell is
 * usable on its own; `verify-overlay.mjs` parses the line instead of trusting the exit code.
 * @param patch - script name, e.g. `qqbot-console`.
 * @param root - the tree that was inspected.
 * @param state - one of `absent`, `patched`, `pristine`, `drifted`.
 * @param detail - the file or anchor the state refers to.
 */
export function report(patch, root, state, detail = '') {
  process.stdout.write(`${JSON.stringify({ patch, root, state, detail })}\n`)
  process.exit(state === 'drifted' ? 1 : 0)
}

/**
 * Split `--check` and a positional tree out of argv.
 *
 * Every script keeps its existing positional signature, so the flag may appear anywhere.
 * @param argv - `process.argv.slice(2)`.
 * @returns the flag and the first positional argument.
 */
export function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    root: argv.find((argument) => !argument.startsWith('--')),
  }
}
