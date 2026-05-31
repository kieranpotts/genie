/**
 * Source classification for the `/realize` command.
 *
 * Turns a single source token (the user may pass several, space-separated) into
 * a structured {@link ResolvedSource}. Accepts a local path, a `file://` URL, an
 * http(s) URL, and the `owner/repo#42` GitHub shorthand. This module performs
 * the only I/O in the extension — a `stat` for local paths and a `gh --version`
 * probe for GitHub URLs — but it deliberately never reads file contents or
 * fetches URL bodies. The agent does that itself, guided by `./prompt.ts`.
 */

import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/**
 * A `/realize` source argument, classified into one of four kinds. The `kind`
 * discriminant selects the matching instruction in `buildRealizePrompt`.
 */
export type ResolvedSource =
  | { kind: 'file', path: string }
  | { kind: 'directory', path: string }
  | { kind: 'github', subtype: 'issue' | 'pr', url: string }
  | { kind: 'url', url: string }

/**
 * A parsed GitHub issue or pull request reference.
 */
export interface GitHubTarget {
  type: 'issue' | 'pr'
  url: string
}

/**
 * Test whether a source string is an HTTP(S) URL.
 *
 * Anything that is not an http(s) URL is treated as a local filesystem path by
 * {@link resolveSource}.
 *
 * @param source - The raw source argument passed to `/realize`.
 * @returns `true` if `source` has an `http://` or `https://` scheme.
 */
export function isUrl (source: string): boolean {
  return /^https?:\/\//i.test(source)
}

/**
 * Test whether a source string is a `file://` URL.
 *
 * Such URLs name a local file rather than something to fetch, so
 * {@link resolveSource} converts them to a filesystem path with
 * {@link fileURLToPath} (which also decodes escapes like `%20`) and then
 * classifies them like any other path.
 *
 * @param source - The raw source argument passed to `/realize`.
 * @returns `true` if `source` has a `file://` scheme.
 */
export function isFileUrl (source: string): boolean {
  return /^file:\/\//i.test(source)
}

/**
 * Strip a single matching pair of wrapping quotes or backticks from a source.
 *
 * Users sometimes paste a path with the surrounding quotes their shell or editor
 * added, eg. `'./my spec.md'`. Only a matching leading/trailing pair is removed;
 * unbalanced or interior quotes are left untouched.
 *
 * @param source - The raw source argument passed to `/realize`.
 * @returns `source` without one pair of wrapping `'`, `"`, or `` ` `` quotes.
 */
export function stripWrappingQuotes (source: string): string {
  const match = source.match(/^(['"`])([\s\S]*)\1$/)
  return match !== null ? match[2] : source
}

/**
 * Parse a GitHub issue or pull request URL into a target descriptor.
 *
 * Recognizes the web URLs for issues and pull requests, eg.
 * `https://github.com/owner/repo/issues/42` and
 * `https://github.com/owner/repo/pull/42`. Any other URL — including other
 * GitHub pages such as a repository root or a file blob — yields `null`.
 *
 * The returned `url` is always *canonical*: scheme and host normalized to
 * `https://github.com`, the `pulls` alias rewritten to `pull`, and any trailing
 * path (eg. `/files`), query, or fragment (eg. `#issuecomment-1`) stripped. This
 * matters because the prompt interpolates the URL into a `gh ... view` command
 * the agent runs in a shell: a `/files` suffix can confuse `gh`, and an unquoted
 * `#` fragment would comment out the rest of the command line.
 *
 * @param source - A source string, which may or may not be a URL.
 * @returns A {@link GitHubTarget} for issues and pull requests, otherwise `null`.
 */
export function parseGitHubTarget (source: string): GitHubTarget | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null /* Not a parseable URL. */
  }

  /* Issue and PR paths only live on the github.com web host. */
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null
  }

  /* Capture /<owner>/<repo>/<issues|pull|pulls>/<number>, ignoring any trailing
     path, query, or fragment so deep links (eg. to a comment) still resolve. */
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull|pulls)\/(\d+)/)
  if (match === null) {
    return null
  }

  const [, owner, repo, kind, number] = match
  const type = kind === 'issues' ? 'issue' : 'pr'
  /* Rebuild a canonical URL rather than echoing the raw input: the agent runs
     this in a shell, so it must be free of trailing paths and `#` fragments. */
  const path = type === 'issue' ? 'issues' : 'pull'
  return { type, url: `https://github.com/${owner}/${repo}/${path}/${number}` }
}

/**
 * Expand the `owner/repo#42` GitHub shorthand into a full issue URL.
 *
 * Recognizes `<owner>/<repo>#<number>`, where neither owner nor repo contains a
 * slash; the `#<number>` suffix is what distinguishes the shorthand from an
 * ordinary relative path. The result is an `issues` URL — GitHub redirects to
 * the pull-request view if the number is a PR — so callers can route it through
 * the same handling as any GitHub URL. To target a pull request explicitly,
 * pass its full `/pull/<n>` URL instead.
 *
 * @param source - A source string, which may or may not be shorthand.
 * @returns The expanded issue URL, or `null` if `source` is not shorthand.
 */
export function parseGitHubShorthand (source: string): string | null {
  const match = source.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/)
  if (match === null) {
    return null
  }

  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/issues/${number}`
}

/**
 * Convert a GitHub file (blob) URL into its `raw.githubusercontent.com`
 * equivalent, so the agent fetches the plain file rather than the HTML page
 * wrapped in GitHub's chrome.
 *
 * Recognizes `https://github.com/<owner>/<repo>/blob/<ref>/<path>` and returns
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. Any trailing
 * query or line-number fragment (eg. `#L5-L9`) is dropped, since `url.pathname`
 * excludes both. Non-blob and non-GitHub URLs yield `null`.
 *
 * Other GitHub pages without a clean machine-readable form — discussions, repo
 * roots, the wiki — are intentionally not special-cased; they fall through to a
 * generic web fetch in {@link resolveSource}.
 *
 * @param source - A source string, which may or may not be a URL.
 * @returns The raw file URL, or `null` if `source` is not a GitHub blob URL.
 */
export function parseGitHubBlob (source: string): string | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null /* Not a parseable URL. */
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null
  }

  /* Capture /<owner>/<repo>/blob/<ref>/<path...>; <ref> may be a branch, tag,
     or commit SHA, and <path> may contain further slashes. */
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (match === null) {
    return null
  }

  const [, owner, repo, refAndPath] = match
  return `https://raw.githubusercontent.com/${owner}/${repo}/${refAndPath}`
}

/**
 * Test whether an executable is available and runnable on the host.
 *
 * Used to decide whether GitHub issue/PR URLs can be resolved through the `gh`
 * CLI. Probes by running `<command> --version`; any failure (missing binary,
 * non-zero exit, spawn error) is treated as "not available".
 *
 * @param command - The executable name to probe, eg. `'gh'`.
 * @returns `true` if the command ran successfully, `false` otherwise.
 */
export async function commandExists (command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Classify a `/realize` source argument into a {@link ResolvedSource}.
 *
 * URLs are inspected for GitHub issue/PR shape; if matched and the `gh` CLI is
 * available, the source resolves as a `github` target (so the agent can use
 * `gh` for clean text). A GitHub file (blob) URL is rewritten to its raw form
 * so the agent fetches the plain file. Anything else resolves as a generic
 * `url`. Non-URL arguments are treated as filesystem paths and `stat`-ed to
 * distinguish a directory from a file. A missing or unreadable path throws.
 *
 * This only *classifies* the source — it never reads file contents or fetches
 * URL bodies. The agent does that itself from the prompt.
 *
 * @param source - The trimmed source argument passed to `/realize`.
 * @returns The resolved, classified source.
 * @throws If `source` is a path that does not exist or cannot be stat-ed.
 */
export async function resolveSource (source: string): Promise<ResolvedSource> {
  /* Tolerate quotes or backticks a user may have pasted around the source. */
  source = stripWrappingQuotes(source)

  /* `owner/repo#42` shorthand expands to a canonical issue URL and then flows
     through the same URL handling below. */
  const shorthand = parseGitHubShorthand(source)
  if (shorthand !== null) {
    source = shorthand
  }

  if (isUrl(source)) {
    const github = parseGitHubTarget(source)
    /* Route through `gh` only when the URL is a GitHub issue/PR and the CLI is
       installed; otherwise fall back to a plain web fetch. */
    if (github !== null && await commandExists('gh')) {
      return { kind: 'github', subtype: github.type, url: github.url }
    }
    /* A GitHub file URL fetches cleanest as raw text, with no `gh` needed. */
    const raw = parseGitHubBlob(source)
    if (raw !== null) {
      return { kind: 'url', url: raw }
    }
    return { kind: 'url', url: source }
  }

  /* Not an http(s) URL: treat as a local path. A `file://` URL is converted to
     its filesystem path first. `stat` throws (eg. ENOENT) for a missing path,
     which the command handler surfaces as a user-facing error. */
  const path = isFileUrl(source) ? fileURLToPath(source) : source
  const stats = await stat(path)
  return stats.isDirectory()
    ? { kind: 'directory', path }
    : { kind: 'file', path }
}
