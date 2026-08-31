// Deterministic canonical JSON (RFC 8785 "JCS" flavored) and SHA-256 helpers.
//
// Dependency-light and Worker-compatible: hashing uses the platform Web Crypto API
// (crypto.subtle), available in both Node >= 15 and Cloudflare Workers.
//
// The contract used by this slice:
//   - objects: keys sorted by UTF-16 code units, then serialized
//   - strings: escape ", \ and control chars U+0000..U+001F (\b \t \n \f \r, else \u00xx);
//     valid UTF-16 surrogate pairs are preserved, LONE surrogates are rejected (RFC 8785 §3.2.2.2:
//     canonical JSON must be freely embeddable / valid Unicode — a lone surrogate cannot be
//     serialized unambiguously, so canonicalJson throws instead of emitting ambiguous bytes)
//   - numbers: finite numbers only. Integers serialize as-is; non-integer finite numbers use the
//     ECMAScript shortest round-trip form (Number#toString), which is deterministic across
//     engines. NaN/Infinity are rejected so no canonical bytes depend on locale formatting.
//     Event payloads are structured IDs, enums and counts (integers); snapshot responses carry
//     ratios (fromPreviousRate) as floats.
//   - booleans/null/arrays: literal
// This is the shared client<->server canonicalization contract; both sides must use the same
// serializer.

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(out, value);
  return out.join('');
}

// canonicalJsonSafe: the same serializer with ONE deliberate difference — a lone surrogate is
// escaped as \uXXXX instead of throwing. This exists ONLY for the quarantine identity fallback:
// canonical JSON must reject lone surrogates (RFC 8785), but quarantine identity for raw wire
// bytes that contain them must stay DETERMINISTIC (identical retry bytes -> identical identity),
// so the fallback serializes with an injective surrogate escape instead of a random value.
export function canonicalJsonSafe(value: unknown): string {
  const out: string[] = [];
  write(out, value, true);
  return out.join('');
}

function write(out: string[], value: unknown, lenient = false): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalError('NaN/Infinity is not canonicalizable');
      }
      out.push(String(value));
      return;
    }
    case 'string':
      out.push(quote(value, lenient));
      return;
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) out.push(',');
          write(out, value[i], lenient);
        }
        out.push(']');
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        compareCodePoints(a, b),
      );
      out.push('{');
      for (let i = 0; i < entries.length; i += 1) {
        if (i > 0) out.push(',');
        out.push(quote(entries[i][0], lenient));
        out.push(':');
        write(out, entries[i][1], lenient);
      }
      out.push('}');
      return;
    }
    default:
      throw new CanonicalError(`unsupported canonical value kind: ${typeof value}`);
  }
}

// Explicit code-point (UTF-16 code unit) comparison: deterministic across runtimes/locales,
// unlike localeCompare. Used for canonical key ordering and any order that must not depend on
// the host collation.
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function quote(input: string, lenient = false): string {
  let out = '"';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // RFC 8785 (JCS): lone surrogates are an error; only well-formed surrogate pairs serialize.
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i += 1;
        continue;
      }
      // Lenient mode (quarantine identity fallback only): a lone surrogate escapes as an explicit
      // \uXXXX literal — deterministic and injective, so distinct raw bytes stay distinct.
      if (lenient) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      throw new CanonicalError('lone surrogate is not canonicalizable');
    }
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += input[i];
        }
    }
  }
  out += '"';
  return out;
}

const encoder = new TextEncoder();

export async function sha256Base64url(input: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input)));
  return base64urlFromBytes(digest);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input)));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

export function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}