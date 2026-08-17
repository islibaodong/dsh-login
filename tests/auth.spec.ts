import { describe, expect, it } from 'vitest'
import {
  COOKIE_NAME,
  verifyPassword,
  extractSessionToken,
  buildCookieHeader,
  buildClearCookieHeader,
} from '../src/auth.ts'

describe('verifyPassword', () => {
  it('returns true for matching strings', () => {
    expect(verifyPassword('s3cret', 's3cret')).toBe(true)
  })

  it('returns false for non-matching strings', () => {
    expect(verifyPassword('s3cret', 'wrong')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(verifyPassword('', 's3cret')).toBe(false)
  })

  it('returns false for different-length strings', () => {
    expect(verifyPassword('short', 'longerpassword')).toBe(false)
  })
})

describe('extractSessionToken', () => {
  it('extracts the dsh_session token from a cookie header', () => {
    const header = 'dsh_session=abc123; other=val'
    expect(extractSessionToken(header)).toBe('abc123')
  })

  it('returns undefined when the cookie header is missing', () => {
    expect(extractSessionToken(undefined)).toBeUndefined()
  })

  it('returns undefined when dsh_session is not present', () => {
    expect(extractSessionToken('other=val')).toBeUndefined()
  })

  it('handles the cookie being the only value', () => {
    expect(extractSessionToken('dsh_session=token123')).toBe('token123')
  })

  it('handles the cookie being the last value', () => {
    expect(extractSessionToken('other=val; dsh_session=lasttoken')).toBe('lasttoken')
  })

  it('returns undefined for a malformed cookie header', () => {
    expect(extractSessionToken('garbage')).toBeUndefined()
  })
})

describe('buildCookieHeader', () => {
  it('builds a Set-Cookie value with all required attributes', () => {
    const header = buildCookieHeader('mytoken', 3600)
    expect(header).toBe('dsh_session=mytoken; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600')
  })

  it('uses the provided TTL in Max-Age', () => {
    const header = buildCookieHeader('tok', 604800)
    expect(header).toContain('Max-Age=604800')
  })
})

describe('buildClearCookieHeader', () => {
  it('builds a Set-Cookie that expires immediately', () => {
    const header = buildClearCookieHeader()
    expect(header).toBe('dsh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  })
})

describe('COOKIE_NAME', () => {
  it('is the string dsh_session', () => {
    expect(COOKIE_NAME).toBe('dsh_session')
  })
})
