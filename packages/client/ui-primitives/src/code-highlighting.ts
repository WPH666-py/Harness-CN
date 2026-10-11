/**
 * File-extension language selection for code surfaces, plus the React binding
 * that lets a component highlight a fragment with the shared lazy highlighter.
 *
 * Language ids are grammar ids the highlighter's alias table resolves, so an id
 * returned here reaches `highlightLines` unchanged; a suffix outside the table,
 * or one naming a language the highlighter does not register, renders as plain
 * text.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { grammarLoadCount, highlightLines, subscribeGrammarLoaded } from './markdown/highlight.ts'
import type { HighlightSpan } from './markdown/highlight.ts'

/**
 * Lowercase extension to canonical language id, each language listed under every
 * suffix it owns. A Map, not an object: a filename whose extension is an
 * `Object.prototype` key (`foo.constructor`, `foo.__proto__`) must miss instead
 * of resolving the inherited member, which would otherwise reach callers as a
 * non-string language value.
 */
const LANGUAGES = new Map<string, string>(Object.entries({
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
}).flatMap(([language, extensions]) => extensions.map(extension => [extension, language] as const)))

/** Every recognized filename suffix, one entry each. */
export const CODE_HIGHLIGHT_EXTENSIONS: readonly string[] = [...LANGUAGES.keys()]

/**
 * The extension of a path's final segment, lowercased. A leading dot is still
 * the separator, so `.env` yields `env`; an absent dot yields `undefined`.
 * @param path - decoded filename or path.
 * @returns the lowercased extension, or undefined when the final segment has no dot.
 */
function extensionForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase()
}

/**
 * Derive the syntax-highlighting language from a filename or path, case
 * insensitively. The extension is the text after the last dot of the final path
 * segment, so `.env` resolves to `dotenv` while an unlisted dotfile
 * (`.gitignore`) and an extensionless name return `undefined`. Both path
 * separators are recognized, so `C:\dir\main.PS1` resolves like `dir/main.ps1`.
 * @param path - decoded filename or path.
 * @returns the canonical language id, or `undefined` for an unrecognized or absent suffix.
 */
export function languageForPath(path: string): string | undefined {
  const extension = extensionForPath(path)
  return extension === undefined ? undefined : LANGUAGES.get(extension)
}

/** Highlight one source fragment into one token list per line. */
export type CodeHighlighter = (code: string) => HighlightSpan[][] | undefined

/**
 * Bind the shared lazy highlighter to one language and refresh after its grammar
 * loads. The subscription is what re-renders a caller that drew the plain
 * fallback while a lazily imported grammar was still arriving.
 * @param language - grammar hint selected from the source filename.
 * @returns a stable fragment highlighter; unknown and loading grammars return `undefined` for plain-text fallback.
 */
export function useCodeHighlighter(language: string | undefined): CodeHighlighter {
  return useCallback(
    (code: string) => highlightLines(code, language),
    [language, useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)],
  )
}
