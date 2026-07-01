import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseForeachArgs } from '../../../src/extensions/foreach/args.ts'

describe('parseForeachArgs', () => {
  it('returns null when fewer than two tokens are given', () => {
    assert.equal(parseForeachArgs(''), null)
    assert.equal(parseForeachArgs('   '), null)
    assert.equal(parseForeachArgs('only-one-token'), null)
  })

  it('treats the last token as the list path and the rest as the instruction', () => {
    assert.deepEqual(parseForeachArgs('Summarize this ./list.txt'), {
      instruction: 'Summarize this',
      listPath: './list.txt'
    })
  })

  it('supports a single-word instruction', () => {
    assert.deepEqual(parseForeachArgs('/review ./prs.txt'), {
      instruction: '/review',
      listPath: './prs.txt'
    })
  })

  it('collapses internal whitespace runs in the instruction', () => {
    const parsed = parseForeachArgs('Do   the thing   ./list.txt')
    assert.equal(parsed?.instruction, 'Do the thing')
    assert.equal(parsed?.listPath, './list.txt')
  })
})
