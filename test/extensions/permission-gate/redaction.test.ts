/**
 * Redaction rules, and — at least as importantly — the things they must leave
 * alone.
 *
 * A redaction is silent: it changes what the model reads without telling the
 * operator at the time. So a false positive is not a cosmetic problem, it is
 * corrupted input producing a confusing failure somewhere else. Half of these
 * tests exist to pin that down, using the shapes the design notes name as the
 * hazards — hashes, UUIDs, lockfile digests, base64 fixtures.
 *
 * The secrets below are syntactically valid and deliberately fake.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactContent, redactText } from '../../../src/extensions/permission-gate/redaction.ts'

describe('redactText — the rules fire on real secret shapes', () => {
  it('replaces an AWS access key id, keeping the surrounding text', () => {
    const out = redactText('aws_access_key_id = AKIAIOSFODNN7EXAMPLE # prod')
    assert.equal(out.value, 'aws_access_key_id = [redacted: aws-access-key-id] # prod')
    assert.equal(out.count, 1)
    assert.deepEqual(out.rules, ['aws-access-key-id'])
  })

  it('replaces a temporary AWS key id too', () => {
    assert.equal(redactText('ASIAIOSFODNN7EXAMPLE').count, 1)
  })

  it('replaces a classic GitHub personal access token', () => {
    const out = redactText('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz')
    assert.equal(out.value, 'token: [redacted: github-token]')
    assert.deepEqual(out.rules, ['github-token'])
  })

  it('replaces a fine-grained GitHub token', () => {
    const out = redactText('github_pat_11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghi')
    assert.equal(out.count, 1)
    assert.deepEqual(out.rules, ['github-token'])
  })

  it('replaces a Slack token', () => {
    assert.deepEqual(redactText('xoxb-123456789012-abcdefghijklmnop').rules, ['slack-token'])
  })

  it('replaces an Anthropic key under its own rule name, not the generic one', () => {
    const out = redactText('ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    assert.deepEqual(out.rules, ['anthropic-api-key'])
    assert.equal(out.value.includes('AbCdEfGh'), false)
  })

  it('replaces an OpenAI project key', () => {
    const out = redactText('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF')
    assert.deepEqual(out.rules, ['openai-api-key'])
  })

  /* Delimiter to delimiter, so the body goes rather than the lines that merely
     look like base64. */
  it('replaces a whole PEM private key block', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxGZlYmFrZXNlY3JldGtleWJvZHloZXJlMTIzNDU2Nzg5MA==',
      'c2Vjb25kbGluZW9mdGhlZmFrZWtleWJvZHlnb2VzcmlnaHRoZXJlMTIzNDU2Nzg=',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const out = redactText(`before\n${key}\nafter`)
    assert.equal(out.value, 'before\n[redacted: private-key-block]\nafter')
    assert.equal(out.count, 1)
  })

  it('replaces an unqualified PKCS#8 block and an OPENSSH block', () => {
    for (const label of ['PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'EC PRIVATE KEY']) {
      const text = `-----BEGIN ${label}-----\nYm9keQ==\n-----END ${label}-----`
      assert.equal(redactText(text).rules[0], 'private-key-block', label)
    }
  })

  /* Two keys in one file must both go: a non-greedy body match, and `g` so the
     scan continues past the first hit. */
  it('replaces every match, not just the first', () => {
    const out = redactText('AKIAIOSFODNN7EXAMPLE and AKIAJKLMNOPQRSTUVWXY')
    assert.equal(out.count, 2)
    assert.equal(out.value.includes('AKIA'), false)
  })

  it('does not let one key block swallow the text between two of them', () => {
    const block = (body: string) =>
      `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
    const out = redactText(`${block('QQ==')}\nKEEP THIS LINE\n${block('Ug==')}`)
    assert.equal(out.count, 2)
    assert.ok(out.value.includes('KEEP THIS LINE'))
  })

  it('reports each rule once and in application order', () => {
    const out = redactText('AKIAIOSFODNN7EXAMPLE AKIAJKLMNOPQRSTUVWXY ghp_1234567890abcdefghijklmnopqrstuvwxyz')
    assert.deepEqual(out.rules, ['aws-access-key-id', 'github-token'])
    assert.equal(out.count, 3)
  })

  /* The redactor must never hand back what it matched — not in the value, not in
     the rule names, not as a length. */
  it('never returns the matched secret in any form', () => {
    const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'
    const out = redactText(`key = ${secret}`)
    const serialised = JSON.stringify(out)
    assert.equal(serialised.includes(secret), false)
    assert.equal(serialised.includes('1234567890abcdef'), false)
  })
})

/* The expensive failure mode. Each of these is a shape the design notes name as
   a hazard, and each must survive untouched. */
describe('redactText — what it must leave alone', () => {
  const untouched = [
    ['a git commit sha', 'commit dc63871a9993fd89dbce9c0588eba1c2d3e4f5a6b7c8d9e0'],
    ['a uuid', 'session 019fb130-40c8-7dd7-b6e5-ef7bf1557f26'],
    ['a sha-512 integrity digest', 'integrity: sha512-Kf8Kx9pDqA1oCcYtEQ2vN5tR7wZmXbJhLpQnGsVdTyUuIiOoPaSdFgHjKlZxCvBnM4='],
    ['a base64 test fixture', 'const fixture = "aGVsbG8gd29ybGQgdGhpcyBpcyBqdXN0IGEgdGVzdCBmaXh0dXJlIHZhbHVl"'],
    ['minified code', 'function a(b){return b.c?d(b.e):f(g,h)}var i=j.k(l,m,n,o,p,q,r,s,t,u,v)'],
    ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'],
    ['an ordinary long identifier', 'export const veryLongCamelCaseIdentifierNameThatKeepsGoingAndGoing = 1'],
    ['a public key block', '-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----'],
    ['a certificate block', '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----'],
    ['the word sk-learn', 'import sk-learn as sk'],
    ['an AKIA prefix that is too short', 'AKIASHORT'],
    ['a lowercase akia string', 'akiaiosfodnn7example'],
  ] as const

  for (const [what, text] of untouched) {
    it(`leaves ${what} untouched`, () => {
      const out = redactText(text)
      assert.equal(out.value, text)
      assert.equal(out.count, 0)
      assert.deepEqual(out.rules, [])
    })
  }

  it('leaves an empty string alone', () => {
    assert.deepEqual(redactText(''), { value: '', count: 0, rules: [] })
  })
})

describe('redactContent', () => {
  it('redacts text parts and counts across all of them', () => {
    const out = redactContent([
      { type: 'text', text: 'first AKIAIOSFODNN7EXAMPLE' },
      { type: 'text', text: 'second ghp_1234567890abcdefghijklmnopqrstuvwxyz' },
    ])
    assert.equal(out.count, 2)
    assert.deepEqual(out.rules, ['aws-access-key-id', 'github-token'])
    assert.equal(out.value[0]!.text, 'first [redacted: aws-access-key-id]')
    assert.equal(out.value[1]!.text, 'second [redacted: github-token]')
  })

  /* A key in a screenshot is not something a regex over a string can see. This
     asserts the stated gap rather than a capability. */
  it('passes non-text parts through by identity', () => {
    const image = { type: 'image', data: 'AKIAIOSFODNN7EXAMPLE', mimeType: 'image/png' }
    const out = redactContent([image])
    assert.equal(out.count, 0)
    assert.equal(out.value[0], image, 'the part must not be rebuilt')
  })

  it('keeps properties it does not model', () => {
    const out = redactContent([
      { type: 'text', text: 'AKIAIOSFODNN7EXAMPLE', textSignature: 'sig' },
    ])
    assert.equal(out.value[0]!.textSignature, 'sig')
  })

  it('returns parts by identity when nothing matched', () => {
    const part = { type: 'text', text: 'nothing secret here' }
    const out = redactContent([part])
    assert.equal(out.count, 0)
    assert.equal(out.value[0], part)
  })

  it('handles an empty content array', () => {
    assert.deepEqual(redactContent([]), { value: [], count: 0, rules: [] })
  })

  it('tolerates a text part with no text', () => {
    const part = { type: 'text' }
    const out = redactContent([part])
    assert.equal(out.count, 0)
    assert.equal(out.value[0], part)
  })
})
