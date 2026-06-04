/**
 * The artifact workspace for a `/realize` pipeline run.
 *
 * Phases hand off through durable files, not a shared conversation (see the
 * SPEC): each phase's output is written as an artifact, and downstream phases
 * read it back as an input. This module defines the {@link Workspace} port the
 * orchestrator depends on, and a filesystem-backed implementation. Keeping it
 * behind a port lets the pipeline be tested without touching disk or git.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * A run-scoped store of pipeline artifacts, and access to the change a coding
 * phase produced.
 */
export interface Workspace {
  /** The directory holding this run's artifacts. */
  readonly dir: string
  /**
   * Write a phase's output as a named artifact.
   *
   * @param name - The artifact file name, eg. `'spec.md'`.
   * @param content - The content to write.
   * @returns The artifact's absolute path, for use as a downstream phase input.
   */
  writeArtifact (name: string, content: string): Promise<string>
  /**
   * Capture the change made to the working tree so far, as a unified diff. This
   * is the coding phase's handoff to the test and review phases.
   *
   * @returns The diff text (empty if nothing has changed).
   */
  captureDiff (): Promise<string>
}

/** Largest diff to capture, in bytes. Beyond this, `git` output is truncated. */
const MAX_DIFF_BYTES = 50 * 1024 * 1024

/**
 * A {@link Workspace} backed by the filesystem and `git`.
 */
export class FileWorkspace implements Workspace {
  readonly dir: string
  private readonly cwd: string

  /**
   * @param dir - The run-scoped artifact directory (created on first write).
   * @param cwd - The project directory `git` runs in.
   */
  constructor (dir: string, cwd: string) {
    this.dir = dir
    this.cwd = cwd
  }

  async writeArtifact (name: string, content: string): Promise<string> {
    /* Created lazily so constructing a workspace has no side effects. */
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, name)
    await writeFile(path, content)
    return path
  }

  /**
   * Capture the working-tree diff against `HEAD`.
   *
   * NOTE: this reports changes to tracked files only; newly created, untracked
   * files do not appear. Including them (eg. via `git add --intent-to-add`)
   * mutates the index, so it is deferred until that trade-off is decided.
   */
  async captureDiff (): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: this.cwd,
      maxBuffer: MAX_DIFF_BYTES
    })
    return stdout
  }
}

/**
 * Generate a sortable, collision-resistant run identifier, eg.
 * `2026-05-31T14-30-00-123Z-a1b2c3`.
 *
 * @returns The run id.
 */
export function newRunId (): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${suffix}`
}

/**
 * Create a filesystem workspace under `<cwd>/.pi/realize/<run-id>/`.
 *
 * The directory itself is created lazily on the first artifact write.
 *
 * @param cwd - The project directory; artifacts live beneath it and `git` runs there.
 * @param runId - The run identifier; a fresh one is generated when omitted.
 * @returns The workspace.
 */
export function createFileWorkspace (cwd: string, runId: string = newRunId()): FileWorkspace {
  return new FileWorkspace(join(cwd, '.pi', 'realize', runId), cwd)
}
