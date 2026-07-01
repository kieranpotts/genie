import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileWorkspace, newRunId, itemFileStem } from '../../../src/extensions/foreach/workspace.ts'

describe('newRunId', () => {
  it('is filesystem-safe and reasonably unique', () => {
    const a = newRunId()
    const b = newRunId()
    assert.notEqual(a, b)
    assert.doesNotMatch(a, /[:.]/)
  })
})

describe('itemFileStem', () => {
  it('zero-pads to the width of the total', () => {
    assert.equal(itemFileStem(0, 5), '1')
    assert.equal(itemFileStem(0, 42), '01')
    assert.equal(itemFileStem(41, 42), '42')
  })
})

describe('createFileWorkspace', () => {
  it('scopes the artifact dir under <cwd>/.pi/foreach/<run-id>', () => {
    const ws = createFileWorkspace('/some/project', 'run-1')
    assert.equal(ws.dir, join('/some/project', '.pi', 'foreach', 'run-1'))
  })
})

describe('FileWorkspace.writeArtifact', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'foreach-workspace-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('creates the directory lazily, writes content, and returns the path', async () => {
    const ws = createFileWorkspace(cwd, 'run-1')
    const path = await ws.writeArtifact('item-01.md', 'hello')
    assert.equal(path, join(cwd, '.pi', 'foreach', 'run-1', 'item-01.md'))
    assert.equal(await readFile(path, 'utf8'), 'hello')
  })
})
