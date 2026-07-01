import type { Workspace } from '../../../src/extensions/foreach/workspace.ts'

/** An in-memory {@link Workspace} for tests: no disk I/O. */
export class FakeWorkspace implements Workspace {
  readonly dir = '/fake/.pi/foreach/run-1'
  readonly artifacts = new Map<string, string>()

  async writeArtifact (name: string, content: string): Promise<string> {
    this.artifacts.set(name, content)
    return `${this.dir}/${name}`
  }
}
