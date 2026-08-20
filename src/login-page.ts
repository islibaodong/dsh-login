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
      width: 760px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .topbar h1 { margin-bottom: 0; }
    .topbar a.logout {
      color: #8f9bb3;
      font-size: 0.875rem;
      text-decoration: none;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 6px 14px;
    }
    .topbar a.logout:hover { color: #ff6b6b; border-color: #ff6b6b; }
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
    td.actions { white-space: nowrap; }
    td.actions button {
      width: auto;
      display: inline-block;
      padding: 5px 10px;
      font-size: 0.8rem;
      margin-right: 4px;
      background: #3a3a5a;
    }
    td.actions button:hover { background: #4a4a7a; }
    td.actions button.danger { background: #6b3546; }
    td.actions button.danger:hover { background: #8b4560; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.75rem;
      margin-right: 4px;
    }
    .badge.online { background: #1d4d33; color: #7fe0a5; }
    .badge.offline { background: #2a2a4a; color: #888; }
    .badge.disabled { background: #5a2a2a; color: #ff9b9b; }
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
    .status {
      color: #8f8;
      font-size: 0.875rem;
      text-align: center;
      min-height: 1.25rem;
      margin-top: 8px;
    }
    dialog {
      background: #16213e;
      color: #e0e0e0;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 24px;
    }
    dialog::backdrop { background: rgba(0,0,0,0.6); }
    dialog h2 { font-size: 1rem; margin-bottom: 16px; }
    dialog input { width: 100%; }
    dialog .row { margin-top: 16px; }
`

/**
 * Admin management page: the user table (role, created, online/disabled
 * status, per-row reset-password / disable / remove actions) plus the
 * create-user form. Populated client-side from GET /api/auth/admin/users;
 * row actions POST their JSON route via fetch and refresh the table.
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
    <div class="topbar">
      <h1>DSH Admin</h1>
      <a class="logout" href="/logout">Log out</a>
    </div>
    <div class="error" id="error"></div>
    <div class="status" id="status"></div>
    <table id="userTable">
      <thead>
        <tr><th>Username</th><th>Role</th><th>Created</th><th>Status</th><th>Actions</th></tr>
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
    </div>
  </div>
  <dialog id="passwordDialog">
    <form id="dialogForm" method="dialog">
      <h2 id="dialogTitle">Reset password</h2>
      <input type="password" id="dialogPassword" placeholder="New password" autocomplete="new-password" required>
      <div class="row">
        <button type="submit" id="dialogConfirm">Set Password</button>
        <button type="button" id="dialogCancel" formnovalidate>Cancel</button>
      </div>
    </form>
  </dialog>
  <script>
    const error = document.getElementById('error');
    const status = document.getElementById('status');
    const dialog = document.getElementById('passwordDialog');
    const dialogPassword = document.getElementById('dialogPassword');
    let dialogUser = null;

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
          const st = document.createElement('td');
          const online = document.createElement('span');
          online.className = 'badge ' + (u.onlineSessions > 0 ? 'online' : 'offline');
          online.textContent = u.onlineSessions > 0 ? ('online ×' + String(u.onlineSessions)) : 'offline';
          st.append(online);
          if (u.disabled) {
            const dis = document.createElement('span');
            dis.className = 'badge disabled';
            dis.textContent = 'disabled';
            st.append(dis);
          }
          const actions = document.createElement('td'); actions.className = 'actions';
          const mk = (label, fn, cls) => {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = label;
            if (cls) b.className = cls;
            b.addEventListener('click', () => { fn(u.username); });
            return b;
          };
          actions.append(
            mk('Reset password', openPasswordDialog),
            mk(u.disabled ? 'Enable' : 'Disable', toggleDisable),
            mk('Remove', removeUser, 'danger'),
          );
          tr.append(name, role, created, st, actions);
          tbody.append(tr);
        }
      } catch (err) {
        error.textContent = 'Failed to load users: ' + err.message;
      }
    }

    function openPasswordDialog(username) {
      dialogUser = username;
      document.getElementById('dialogTitle').textContent = 'Reset password — ' + username;
      dialogPassword.value = '';
      dialog.showModal();
      dialogPassword.focus();
    }

    document.getElementById('dialogCancel').addEventListener('click', () => dialog.close());
    document.getElementById('dialogForm').addEventListener('submit', async () => {
      const username = dialogUser;
      const password = dialogPassword.value;
      dialog.close();
      if (username === null || password.length === 0) return;
      error.textContent = '';
      try {
        await call('/api/auth/admin/users/password', 'POST', { username, password });
        flash('Password reset for ' + username);
        refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    });

    async function toggleDisable(username) {
      error.textContent = '';
      const row = document.querySelector('#userTable tbody').querySelectorAll('tr');
      let disabled = false;
      for (const tr of row) {
        if (tr.cells[0].textContent === username) disabled = tr.querySelector('.badge.disabled') !== null;
      }
      if (!disabled && !window.confirm('Disable user "' + username + '"? Their sessions will be revoked.')) return;
      try {
        await call('/api/auth/admin/users/disable', 'POST', { username, disabled: !disabled });
        flash((!disabled ? 'Disabled ' : 'Enabled ') + username);
        refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    }

    async function removeUser(username) {
      if (!window.confirm('Remove user "' + username + '"? This cannot be undone.')) return;
      error.textContent = '';
      try {
        await call('/api/auth/admin/users/remove', 'POST', { username });
        flash('Removed ' + username);
        refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    }

    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await call('/api/auth/admin/users', 'POST', {
          username: document.getElementById('newUsername').value,
          password: document.getElementById('newPassword').value,
          isAdmin: document.getElementById('newIsAdmin').checked,
        });
        flash('OK');
        refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    });

    refresh();
  </script>
</body>
</html>`
}
