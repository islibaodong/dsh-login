import { describe, expect, it } from 'vitest'
import { renderAdminPage, renderLoginPage, renderSetupPage } from '../src/login-page.ts'

describe('renderLoginPage', () => {
  const html = renderLoginPage()

  it('returns a complete HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains username and password input fields', () => {
    expect(html).toContain('name="username"')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('type="password"')
    expect(html).toContain('id="password"')
  })

  it('contains a submit button', () => {
    expect(html).toContain('type="submit"')
  })

  it('sends {username, password} to the login endpoint', () => {
    expect(html).toContain('/api/auth/login')
    expect(html).toMatch(/JSON\.stringify\(\{\s*username/)
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

describe('renderSetupPage', () => {
  const html = renderSetupPage()

  it('returns a complete HTML document with a username field', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('name="username"')
    expect(html).toContain('autocomplete="username"')
  })

  it('POSTs {username, password} to the setup endpoint', () => {
    expect(html).toContain('/api/auth/setup')
    expect(html).toMatch(/JSON\.stringify\(\{\s*username/)
  })

  it('keeps the password confirmation flow', () => {
    expect(html).toContain('id="confirm"')
  })
})

describe('renderAdminPage', () => {
  const html = renderAdminPage()

  it('returns a complete self-contained HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('src="http')
  })

  it('shares the DSH dark theme with the login page', () => {
    expect(html).toContain('#1a1a2e')
    expect(html).toContain('.card')
  })

  it('calls all four admin JSON routes and refreshes the table on success', () => {
    expect(html).toContain('/api/auth/admin/users')
    expect(html).toContain('/api/auth/admin/users/password')
    expect(html).toContain('/api/auth/admin/users/remove')
    expect(html).toContain('/api/auth/admin/users/disable')
    expect(html).toContain('refresh()')
  })

  it('renders a user table with status badges and per-row actions', () => {
    expect(html).toContain('<table')
    expect(html).toContain('fetch(')
    expect(html).toContain("badge ' + (u.onlineSessions > 0 ? 'online' : 'offline')")
    expect(html).toContain('badge.disabled')
    expect(html).toContain('Reset password')
    expect(html).toContain("'Disable'")
    expect(html).toContain("'Remove'")
  })

  it('offers a logout link and a reset-password dialog', () => {
    expect(html).toContain('href="/logout"')
    expect(html).toContain('<dialog')
    expect(html).toContain('dialogPassword')
  })
})
