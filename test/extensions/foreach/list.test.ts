import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseList } from '../../../src/extensions/foreach/list.ts'

describe('parseList', () => {
  it('returns one item per non-blank line', () => {
    assert.deepEqual(parseList('a\nb\nc'), ['a', 'b', 'c'])
  })

  it('skips blank lines', () => {
    assert.deepEqual(parseList('a\n\n\nb\n'), ['a', 'b'])
  })

  it('skips comment lines', () => {
    assert.deepEqual(parseList('# heading\na\n# note\nb'), ['a', 'b'])
  })

  it('trims each item', () => {
    assert.deepEqual(parseList('  a  \n\tb\t'), ['a', 'b'])
  })

  it('handles CRLF line endings', () => {
    assert.deepEqual(parseList('a\r\nb\r\n'), ['a', 'b'])
  })

  it('returns an empty array for an empty or all-comment file', () => {
    assert.deepEqual(parseList(''), [])
    assert.deepEqual(parseList('# only comments\n# here'), [])
  })
})
