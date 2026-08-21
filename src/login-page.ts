/**
 * Self-contained HTML pages (inline CSS + JS, DSH dark theme, string-template
 * style — no template engine): the login form and the first-time setup form.
 * No external assets. The admin management page was removed — user
 * management now ships inside the GUI settings panel (设置-用户管理) via the
 * browser bundle's settings section.
 */
const BASE_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #16213e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      max-width: 90vw;
    }
    .card h1 {
      font-size: 1.5rem;
      margin-bottom: 24px;
      text-align: center;
      color: #e0e0e0;
    }
    .card .subtitle {
      font-size: 0.8rem;
      color: #888;
      text-align: center;
      margin-bottom: 24px;
    }
    .card input[type="text"], .card input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      margin-bottom: 16px;
      outline: none;
    }
    .card input[type="text"]:focus, .card input[type="password"]:focus {
      border-color: #4a4a6a;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #4a6fa5;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card button[type="submit"]:hover {
      background: #5a7fb5;
    }
    .card button[type="submit"]:disabled {
      background: #3a3a5a;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.875rem;
      text-align: center;
      margin-bottom: 16px;
      min-height: 1.25rem;
    }
`

/** Login page: username + password, POSTs {username, password}. */
export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Login</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit" id="submit">Login</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = 'Invalid username or password';
          password.value = '';
          password.focus();
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else if (res.status === 500) {
          error.textContent = 'Server error - no users configured';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Login';
      }
    });
  </script>
</body>
</html>`
}

/** First-time setup page: creates the admin account via {username, password}. */
export function renderSetupPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Setup</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="subtitle">First-time setup: create the administrator account</div>
    <div class="error" id="error"></div>
    <form id="setupForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="New password" autocomplete="new-password" required>
      <input type="password" id="confirm" placeholder="Confirm password" autocomplete="new-password" required>
      <button type="submit" id="submit">Create Account</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('setupForm');
    const username = document.getElementById('username');
    const pw = document.getElementById('password');
    const cf = document.getElementById('confirm');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (username.value.length < 1) {
        error.textContent = 'Username cannot be empty';
        return;
      }
      if (pw.value.length < 1) {
        error.textContent = 'Password cannot be empty';
        return;
      }
      if (pw.value !== cf.value) {
        error.textContent = 'Passwords do not match';
        cf.value = '';
        cf.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: pw.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 403) {
          error.textContent = 'Setup already completed';
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create Account';
      }
    });
  </script>
</body>
</html>`
}
