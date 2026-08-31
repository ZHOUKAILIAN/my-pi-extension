import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlFromBytes, canonicalJson, canonicalJsonSafe, CanonicalError, sha256Base64url, sha256Hex } from '../src/canonical.ts';

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { y: true, x: null } });
    const b = canonicalJson({ c: { x: null, y: true }, a: 2, b: 1 });
    assert.equal(a, b);
    assert.ok(a.includes('"a":2'));
    assert.ok(a.includes('"b":1'));
  });

  it('escapes quotes, backslashes and control characters', () => {
    const out = canonicalJson({ text: 'a"b\\c\td' });
    assert.equal(out, '{"text":"a\\"b\\\\c\\td"}');
    const nul = canonicalJson({ x: '\u0000' });
    assert.equal(nul, '{"x":"\\u0000"}');
  });

  it('handles arrays, booleans and null literally', () => {
    assert.equal(canonicalJson([1, true, null]), '[1,true,null]');
  });

  it('rejects floats, NaN and Infinity', () => {
    assert.throws(() => canonicalJson({ x: NaN }));
    assert.throws(() => canonicalJson({ x: Infinity }));
  });

  it('serializes finite floats deterministically', () => {
    assert.equal(canonicalJson({ x: 0.5 }), '{"x":0.5}');
    assert.equal(canonicalJson({ x: 1 / 3 }), '{"x":0.3333333333333333}');
    assert.equal(canonicalJson({ x: 1, y: 2 }), '{"x":1,"y":2}');
  });

  it('rejects unsupported kinds (functions)', () => {
    assert.throws(() => canonicalJson({ x: () => 1 }));
  });

  it('rejects lone surrogates and preserves valid surrogate pairs (RFC 8785 §3.2.2.2)', () => {
    // a lone high surrogate anywhere in a string is an error, never ambiguous output bytes
    assert.throws(() => canonicalJson({ x: '\ud800' }), CanonicalError);
    assert.throws(() => canonicalJson({ x: 'trailing\udc00' }), CanonicalError);
    // a low surrogate without a preceding high surrogate is lone too
    assert.throws(() => canonicalJson({ x: '\udc00\ud800' }), CanonicalError);
    // well-formed pairs serialize unchanged (same bytes JSON.stringify would emit)
    const pair = 'a\ud83d\ude00b';
    assert.equal(canonicalJson({ x: pair }), JSON.stringify({ x: pair }));
    assert.equal(canonicalJson([pair]), JSON.stringify([pair]));
  });
  it('canonicalJsonSafe escapes lone surrogates deterministically (quarantine identity fallback)', () => {
    // canonicalJson rejects lone surrogates; the safe variant escapes them as an injective \uXXXX
    // literal so identical raw bytes always hash to the same quarantine identity
    assert.throws(() => canonicalJson({ x: '\ud800' }), CanonicalError);
    const a = canonicalJsonSafe({ x: '\ud800' });
    const b = canonicalJsonSafe({ x: '\ud800' });
    assert.equal(a, b);
    assert.ok(a.includes('\\ud800'));
    // distinct lone surrogates stay distinct; valid pairs still serialize unchanged
    assert.notEqual(canonicalJsonSafe({ x: '\ud800' }), canonicalJsonSafe({ x: '\udbff' }));
    assert.equal(canonicalJsonSafe({ x: 'a\ud83d\ude00b' }), JSON.stringify({ x: 'a\ud83d\ude00b' }));
    // key ordering matches the strict serializer
    assert.equal(canonicalJsonSafe({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });
});

describe('sha256', () => {
  it('matches the RFC 6234 empty-input vector (base64url)', async () => {
    assert.equal(await sha256Base64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('hex and base64url agree', async () => {
    const hex = await sha256Hex('fix-funnel-v1');
    const b64 = await sha256Base64url('fix-funnel-v1');
    assert.match(b64, /^[A-Za-z0-9_-]+$/);
    assert.ok(!b64.includes('='));
    assert.equal(b64, Buffer.from(hex, 'hex').toString('base64url'));
  });

  it('base64urlFromBytes is URL-safe and unpadded', () => {
    assert.equal(base64urlFromBytes(new Uint8Array([0xfb, 0xff, 0xfe])), '-__-');
  });
});