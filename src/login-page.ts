/**
 * Self-contained HTML pages (inline CSS + JS, DSH dark theme, string-template
 * style — no template engine): the login form, the first-time setup form, and
 * the admin management page. No external assets.
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

/** Admin page CSS additions over the base card theme. */
const ADMIN_CSS = `
    .card.wide {
      width: 640px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #2a2a4a;
    }
    th { color: #888; font-weight: 500; }
    .forms {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .forms h2 {
      font-size: 1rem;
      margin-bottom: 12px;
      color: #c0c0d0;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row input { margin-bottom: 0; }
    .row button {
      white-space: nowrap;
      width: auto;
      padding: 12px 16px;
    }
    .status {
      color: #8f8;
      font-size: 0.875rem;
      text-align: center;
      min-height: 1.25rem;
      margin-top: 8px;
    }
`

/**
 * Admin management page: the user table plus create/change-password/remove
 * forms. Populated client-side from GET /api/auth/admin/users; every form
 * POSTs its JSON route via fetch and reloads on success.
 */
export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Admin</title>
  <style>${BASE_CSS}${ADMIN_CSS}</style>
</head>
<body>
  <div class="card wide">
    <h1>DSH Admin</h1>
    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
    <table id="userTable">
      <thead>
        <tr><th>Username</th><th>Role</th><th>Created</th></tr>
      </thead>
      <tbody></tbody>
    </table>
    <div class="forms">
      <form id="createForm">
        <h2>Create user</h2>
        <input type="text" id="newUsername" placeholder="Username" autocomplete="off" required>
        <input type="password" id="newPassword" placeholder="Password" autocomplete="new-password" required>
        <label><input type="checkbox" id="newIsAdmin"> Admin</label>
        <button type="submit">Create</button>
      </form>
      <form id="passwordForm">
        <h2>Change password</h2>
        <input type="text" id="pwUsername" placeholder="Username" autocomplete="off" required>
        <input type="password" id="pwPassword" placeholder="New password" autocomplete="new-password" required>
        <button type="submit">Set Password</button>
      </form>
      <form id="removeForm">
        <h2>Remove user</h2>
        <input type="text" id="removeUsername" placeholder="Username" autocomplete="off" required>
        <button type="submit">Remove</button>
      </form>
    </div>
  </div>
  <script>
    const error = document.getElementById('error');
    const status = document.getElementById('status');

    const fmtDate = (ms) => new Date(ms).toLocaleString();
    const flash = (msg) => { status.textContent = msg; setTimeout(() => { status.textContent = ''; }, 3000); };

    async function call(path, method, body) {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...body !== undefined ? { body: JSON.stringify(body) } : {},
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error ?? ''; } catch (e) {}
        throw new Error(detail || ('HTTP ' + String(res.status)));
      }
      return res.json();
    }

    async function refresh() {
      try {
        const data = await call('/api/auth/admin/users', 'GET');
        const tbody = document.querySelector('#userTable tbody');
        tbody.innerHTML = '';
        for (const u of data.users) {
          const tr = document.createElement('tr');
          const name = document.createElement('td'); name.textContent = u.username;
          const role = document.createElement('td'); role.textContent = u.isAdmin ? 'admin' : 'user';
          const created = document.createElement('td'); created.textContent = fmtDate(u.createdAt);
          tr.append(name, role, created);
          tbody.append(tr);
        }
      } catch (err) {
        error.textContent = 'Failed to load users: ' + err.message;
      }
    }

    const formHandler = (form, action) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await action();
          flash('OK');
          window.location.reload();
        } catch (err) {
          error.textContent = err.message;
        }
      });
    };

    formHandler(document.getElementById('createForm'), async () => {
      await call('/api/auth/admin/users', 'POST', {
        username: document.getElementById('newUsername').value,
        password: document.getElementById('newPassword').value,
        isAdmin: document.getElementById('newIsAdmin').checked,
      });
    });
    formHandler(document.getElementById('passwordForm'), async () => {
      await call('/api/auth/admin/users/password', 'POST', {
        username: document.getElementById('pwUsername').value,
        password: document.getElementById('pwPassword').value,
      });
    });
    formHandler(document.getElementById('removeForm'), async () => {
      await call('/api/auth/admin/users/remove', 'POST', {
        username: document.getElementById('removeUsername').value,
      });
    });

    refresh();
  </script>
</body>
</html>`
}
