import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseInstruction, buildItemTask } from '../../../src/extensions/foreach/instruction.ts'

describe('parseInstruction', () => {
  it('classifies a leading-slash instruction as a skill reference', () => {
    assert.deepEqual(parseInstruction('/review'), { kind: 'skill', name: 'review' })
  })

  it('trims whitespace around the skill name', () => {
    assert.deepEqual(parseInstruction('/  review  '), { kind: 'skill', name: 'review' })
  })

  it('classifies anything else as freeform text', () => {
    assert.deepEqual(parseInstruction('Summarize this'), { kind: 'freeform', text: 'Summarize this' })
  })
})

describe('buildItemTask', () => {
  it('hands a skill instruction just the item', () => {
    const task = buildItemTask({ kind: 'skill', name: 'review' }, 'owner/repo#42')
    assert.equal(task, 'owner/repo#42')
  })

  it('pairs a freeform instruction with the item', () => {
    const task = buildItemTask({ kind: 'freeform', text: 'Summarize this' }, 'owner/repo#42')
    assert.match(task, /^Summarize this\n\n/)
    assert.match(task, /owner\/repo#42$/)
  })
})
