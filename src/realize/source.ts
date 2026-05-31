/**
 * Source classification for the `/realize` command.
 *
 * Turns the single argument the user passes to `/realize` into a structured
 * {@link ResolvedSource}. This module performs the only I/O in the extension —
 * a `stat` for local paths and a `gh --version` probe for GitHub URLs — but it
 * deliberately never reads file contents or fetches URL bodies. The agent does
 * that itself, guided by the prompt built in `./prompt.ts`.
 */

import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
 * `gh` for clean text), otherwise as a generic `url`. Non-URL arguments are
 * treated as filesystem paths and `stat`-ed to distinguish a directory from a
 * file. A missing or unreadable path throws.
 *
 * This only *classifies* the source — it never reads file contents or fetches
 * URL bodies. The agent does that itself from the prompt.
 *
 * @param source - The trimmed source argument passed to `/realize`.
 * @returns The resolved, classified source.
 * @throws If `source` is a path that does not exist or cannot be stat-ed.
 */
export async function resolveSource (source: string): Promise<ResolvedSource> {
  if (isUrl(source)) {
    const github = parseGitHubTarget(source)
    /* Route through `gh` only when the URL is a GitHub issue/PR and the CLI is
       installed; otherwise fall back to a plain web fetch. */
    if (github !== null && await commandExists('gh')) {
      return { kind: 'github', subtype: github.type, url: github.url }
    }
    return { kind: 'url', url: source }
  }

  /* Not a URL: treat as a local path. `stat` throws (eg. ENOENT) for a missing
     path, which the command handler surfaces as a user-facing error. */
  const stats = await stat(source)
  return stats.isDirectory()
    ? { kind: 'directory', path: source }
    : { kind: 'file', path: source }
}
