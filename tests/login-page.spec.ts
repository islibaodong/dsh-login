import { describe, expect, it } from 'vitest'
import { renderLoginPage } from '../src/login-page.ts'

describe('renderLoginPage', () => {
  const html = renderLoginPage()

  it('returns a complete HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains a password input field', () => {
    expect(html).toContain('type="password"')
    expect(html).toContain('id="password"')
  })

  it('contains a submit button', () => {
    expect(html).toContain('type="submit"')
  })

  it('contains the login endpoint URL in inline JS', () => {
    expect(html).toContain('/api/auth/login')
  })

  it('redirects to root on success', () => {
    expect(html).toContain("window.location")
    expect(html).toContain("'/'")
  })

  it('shows an error message on 401', () => {
    expect(html).toContain('401')
    expect(html.toLowerCase()).toBe(html.toLowerCase())
  })

  it('is self-contained with no external resources', () => {
    expect(html).not.toContain('src="http')
    expect(html).not.toContain('href="http')
    expect(html).not.toContain('<link')
  })

  it('uses a dark background color', () => {
    expect(html).toContain('background')
    expect(html).toMatch(/dark|#1|#0|#2[0-9a-f]/i)
  })
})
