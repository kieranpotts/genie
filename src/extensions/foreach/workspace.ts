/**
 * The artifact workspace for a `/foreach` run.
 *
 * Each item's output is written as a numbered artifact, and the run finishes
 * with a summary artifact. Kept behind a {@link Workspace} port, as in
 * `realize`, so the loop is tested without touching disk.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A run-scoped store of `/foreach` artifacts. */
export interface Workspace {
  /** The directory holding this run's artifacts. */
  readonly dir: string
  /**
   * Write a named artifact.
   *
   * @param name - The artifact file name, eg. `'item-01.md'`.
   * @param content - The content to write.
   * @returns The artifact's absolute path.
   */
  writeArtifact (name: string, content: string): Promise<string>
}

/**
 * A {@link Workspace} backed by the filesystem.
 */
export class FileWorkspace implements Workspace {
  readonly dir: string

  constructor (dir: string) {
    this.dir = dir
  }

  async writeArtifact (name: string, content: string): Promise<string> {
    /* Created lazily so constructing a workspace has no side effects. */
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, name)
    await writeFile(path, content)
    return path
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
 * Create a filesystem workspace under `<cwd>/.pi/foreach/<run-id>/`.
 *
 * @param cwd - The project directory; artifacts live beneath it.
 * @param runId - The run identifier; a fresh one is generated when omitted.
 * @returns The workspace.
 */
export function createFileWorkspace (cwd: string, runId: string = newRunId()): FileWorkspace {
  return new FileWorkspace(join(cwd, '.pi', 'foreach', runId))
}

/**
 * Zero-pad an item's position for a stable, sortable artifact filename, eg.
 * item 3 of 42 becomes `'03'`.
 *
 * @param index - The zero-based item index.
 * @param total - The total number of items in the run.
 * @returns The zero-padded, one-based position string.
 */
export function itemFileStem (index: number, total: number): string {
  const width = String(total).length
  return String(index + 1).padStart(width, '0')
}
