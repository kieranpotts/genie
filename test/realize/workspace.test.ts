import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWorkspace, createFileWorkspace, newRunId } from '../../src/realize/workspace.ts'

const execFileAsync = promisify(execFile)

describe('newRunId', () => {
  it('is filesystem-safe and reasonably unique', () => {
    const id = newRunId()
    assert.match(id, /^[\w-]+$/, 'no path-hostile characters')
    assert.notEqual(newRunId(), newRunId())
  })
})

describe('createFileWorkspace', () => {
  it('scopes the artifact dir under <cwd>/.pi/realize/<run-id>', () => {
    const ws = createFileWorkspace('/proj', 'run-7')
    assert.equal(ws.dir, join('/proj', '.pi', 'realize', 'run-7'))
  })
})

describe('FileWorkspace.writeArtifact', () => {
  it('creates the directory lazily, writes content, and returns the path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'realize-ws-'))
    try {
      const dir = join(root, 'artifacts')
      const ws = new FileWorkspace(dir, root)

      /* Constructing the workspace must not create the directory. */
      await assert.rejects(stat(dir))

      const path = await ws.writeArtifact('spec.md', '# Spec\n')
      assert.equal(path, join(dir, 'spec.md'))
      assert.equal(await readFile(path, 'utf8'), '# Spec\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FileWorkspace.captureDiff', () => {
  it('returns the working-tree diff against HEAD', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'realize-git-'))
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: repo })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      await writeFile(join(repo, 'file.txt'), 'original\n')
      await execFileAsync('git', ['add', '.'], { cwd: repo })
      await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo })

      /* No changes yet: an empty diff. */
      const ws = new FileWorkspace(join(repo, '.artifacts'), repo)
      assert.equal(await ws.captureDiff(), '')

      /* After a tracked-file change, the diff reflects it. */
      await writeFile(join(repo, 'file.txt'), 'changed\n')
      const diff = await ws.captureDiff()
      assert.match(diff, /-original/)
      assert.match(diff, /\+changed/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
