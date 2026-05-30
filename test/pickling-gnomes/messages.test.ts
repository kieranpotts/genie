import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { participles, nouns, randomItem, randomMessage } from '../../src/pickling-penguins/messages.ts'

describe('word lists', () => {
  it('hold enough words for 10,000+ combinations', () => {
    assert.ok(participles.length >= 100, `only ${participles.length} participles`)
    assert.ok(nouns.length >= 100, `only ${nouns.length} nouns`)
    assert.ok(participles.length * nouns.length > 10000)
  })

  it('contain no duplicates', () => {
    assert.equal(new Set(participles).size, participles.length)
    assert.equal(new Set(nouns).size, nouns.length)
  })

  it('are sorted alphabetically', () => {
    const sorted = (list: readonly string[]): string[] =>
      [...list].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    assert.deepEqual(participles, sorted(participles))
    assert.deepEqual(nouns, sorted(nouns))
  })

  it('have no empty entries or stray whitespace', () => {
    for (const word of [...participles, ...nouns]) {
      assert.equal(word, word.trim())
      assert.ok(word.length > 0)
    }
  })
})

describe('randomItem', () => {
  it('returns an element drawn from the list', () => {
    const list = ['a', 'b', 'c'] as const
    for (let i = 0; i < 100; i++) {
      assert.ok(list.includes(randomItem(list)))
    }
  })

  it('can reach every element of the list', () => {
    const list = ['a', 'b', 'c'] as const
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(randomItem(list))
    assert.equal(seen.size, list.length)
  })
})

describe('randomMessage', () => {
  it('starts with a capital letter and ends with an ellipsis', () => {
    for (let i = 0; i < 200; i++) {
      const message = randomMessage()
      assert.match(message, /^[A-ZÀ-Þ].*\.\.\.$/u, `unexpected shape: ${message}`)
    }
  })

  it('pairs a real participle with a real noun', () => {
    for (let i = 0; i < 200; i++) {
      const body = randomMessage().slice(0, -3) // drop trailing "..."
      const participle = participles.find((p) => body.toLowerCase().startsWith(p))
      assert.ok(participle, `no participle found in: ${body}`)
      const noun = body.slice(participle.length + 1)
      assert.ok(nouns.includes(noun), `not a known noun: ${noun}`)
    }
  })
})
