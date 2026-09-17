/**
 * Self-contained HTML pages (inline CSS + JS, string-template style — no
 * template engine): the login form and the first-time setup form. No external
 * assets. Visual identity: a split screen — left, the dark DSH side (plugin
 * board backdrop, brand, the "everything is a plugin" story with a layered
 * feature list, loaded badge); right, a light card holding the form. User
 * management ships inside the GUI settings panel (设置-用户管理) via the
 * browser bundle, not here.
 */

/**
 * Plugin board ambience: tiles are laid out inside the dark pane by inline
 * JS (snapped to the grid).
 */
const BOARD_JS = `
    (function () {
      var reduce = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var board = document.getElementById('board');
      var pane = document.getElementById('paneDark');
      var CELL = 72, SIZE = 56;

      function layout() {
        board.innerHTML = '';
        var W = pane.clientWidth, H = pane.clientHeight;
        var cols = Math.ceil(W / CELL);
        var rows = Math.ceil(H / CELL);
        var count = Math.min(18, Math.max(8, Math.round(cols * rows * 0.04)));
        var picks = {};
        var placed = 0, guard = 0;
        while (placed < count && guard++ < cols * rows * 4) {
          var c = Math.floor(Math.random() * cols);
          var r = Math.floor(Math.random() * rows);
          var x = c * CELL + (CELL - SIZE) / 2;
          var y = r * CELL + (CELL - SIZE) / 2;
          // keep the space behind the text block clean
          if (x < 520 && y > H * 0.18 && y < H * 0.82) continue;
          var key = c + ':' + r;
          if (picks[key]) continue;
          picks[key] = true;
          var t = document.createElement('div');
          t.className = 'tile' + (Math.random() < 0.35 ? ' tile--lit' : '');
          t.style.left = x + 'px';
          t.style.top = y + 'px';
          t.style.setProperty('--d', (placed * 45) + 'ms');
          if (!reduce && Math.random() < 0.4) {
            t.style.setProperty('--breath-delay', (6 + Math.random() * 16) + 's');
          }
          board.appendChild(t);
          placed++;
        }
      }

      var tm;
      window.addEventListener('resize', function () {
        clearTimeout(tm);
        tm = setTimeout(layout, 200);
      });
      layout();
    })();
`

const BASE_CSS = `
    :root {
      --bg: #0f1420;
      --panel: #151b2c;
      --inset: #0d1220;
      --line: #262f47;
      --line-soft: #1c2438;
      --text: #e8ebf4;
      --muted: #97a0b6;
      --accent: #6f9bff;
      --accent-soft: rgba(111, 155, 255, 0.14);
      --ok: #46d19a;
      --lt-bg: #f3f5fa;
      --lt-card: #ffffff;
      --lt-line: #e1e6f1;
      --lt-inset: #f6f8fc;
      --lt-text: #1d2536;
      --lt-muted: #67718c;
      --danger: #d64545;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      min-height: 100vh;
    }

    .split {
      display: flex;
      min-height: 100vh;
    }
    .pane { flex: 1 1 50%; position: relative; }

    /* ---- left: the dark DSH side ---- */
    .pane--dark {
      flex-basis: 53%;
      background: var(--bg);
      overflow: hidden;
    }
    .board-bg {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(var(--line-soft) 1px, transparent 1px),
        linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
      background-size: 72px 72px;
      opacity: 0.35;
    }
    .board-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(
        ellipse 90% 80% at 30% 50%,
        transparent 30%, var(--bg) 100%
      );
    }
    #board { position: absolute; inset: 0; pointer-events: none; }
    .tile {
      position: absolute;
      width: 56px;
      height: 56px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(21, 27, 44, 0.55);
      opacity: 0;
      animation: tileIn 0.6s ease both;
      animation-delay: var(--d, 0ms);
    }
    .tile--lit {
      border-color: rgba(111, 155, 255, 0.45);
      background: var(--accent-soft);
      animation: tileIn 0.6s ease both, breath 7s ease-in-out infinite;
      animation-delay: var(--d, 0ms), var(--breath-delay, 4s);
    }
    .tile--lit::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 6px;
      height: 6px;
      margin: -3px 0 0 -3px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.8;
    }
    @keyframes tileIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 0.9; transform: none; }
    }
    @keyframes breath {
      0%, 100% { box-shadow: 0 0 0 0 rgba(111, 155, 255, 0); }
      50% { box-shadow: 0 0 22px 0 rgba(111, 155, 255, 0.16); }
    }

    .pane-content {
      position: relative;
      height: 100%;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 48px 60px;
      max-width: 560px;
      animation: rise 0.55s cubic-bezier(0.22, 0.8, 0.36, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: none; }
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-row svg { flex: none; }
    .brand-row .wordmark {
      font-size: 2.35rem;
      font-weight: 750;
      letter-spacing: 0.02em;
      line-height: 1;
    }
    .kicker {
      margin-top: 16px;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.01em;
    }
    .lead {
      margin-top: 10px;
      font-size: 0.88rem;
      color: var(--muted);
      line-height: 1.75;
      max-width: 26em;
    }

    .features {
      list-style: none;
      margin-top: 44px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .features li {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .features li i {
      flex: none;
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 2.5px;
      background: var(--accent-soft);
      border: 1px solid rgba(111, 155, 255, 0.5);
    }
    .features li b {
      display: block;
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 3px;
    }
    .features li span {
      display: block;
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.6;
    }

    .footnote {
      position: absolute;
      left: 60px;
      bottom: 56px;
      font-size: 0.7rem;
      color: #6b7490;
      line-height: 1.6;
    }
    .loaded {
      position: absolute;
      left: 60px;
      bottom: 30px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      color: #6b7490;
    }
    .loaded i {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 6px rgba(70, 209, 154, 0.55);
    }

    /* ---- right: the light form side ---- */
    .pane--light {
      background: var(--lt-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 32px;
    }
    /* soft blue glow seating the card */
    .pane--light::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(
        ellipse 55% 48% at 50% 46%,
        rgba(111, 155, 255, 0.09), transparent 70%
      );
    }

    /* ghost plugin tiles: the board's quiet echoes on this side */
    .ghost {
      position: absolute;
      width: 46px;
      height: 46px;
      border: 1px solid #dfe5f0;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      pointer-events: none;
      animation: rise 0.7s cubic-bezier(0.22, 0.8, 0.36, 1) both;
    }
    .ghost--g1 { top: 11%; left: 13%; animation-delay: 320ms; }
    .ghost--g2 { bottom: 13%; right: 11%; animation-delay: 420ms; }
    .ghost--g3 {
      top: 15%;
      right: 15%;
      border-color: rgba(111, 155, 255, 0.4);
      background: #eef2fd;
      animation-delay: 520ms;
    }
    .ghost--g3::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 5px;
      height: 5px;
      margin: -2.5px 0 0 -2.5px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.7;
    }

    /* free plugin slots, top-right: one is taken */
    .slots {
      position: absolute;
      top: 26px;
      right: 30px;
      display: flex;
      gap: 7px;
      pointer-events: none;
      animation: rise 0.7s cubic-bezier(0.22, 0.8, 0.36, 1) both;
      animation-delay: 600ms;
    }
    .slots span {
      width: 9px;
      height: 9px;
      border: 1px solid #cdd6e6;
      border-radius: 3px;
    }
    .slots span:first-child {
      background: var(--accent);
      border-color: var(--accent);
      opacity: 0.75;
    }

    .card {
      position: relative;
      z-index: 1;
      width: 372px;
      max-width: 100%;
      background: var(--lt-card);
      border: 1px solid var(--lt-line);
      border-radius: 16px;
      padding: 34px 34px 30px;
      box-shadow: 0 14px 36px rgba(23, 32, 55, 0.08);
      animation: rise 0.55s cubic-bezier(0.22, 0.8, 0.36, 1) both;
      animation-delay: 130ms;
    }
    .card h1 {
      font-size: 1.3rem;
      font-weight: 650;
      color: var(--lt-text);
      margin-bottom: 6px;
    }
    .card .subtitle {
      font-size: 0.82rem;
      color: var(--lt-muted);
      line-height: 1.6;
      margin-bottom: 20px;
    }
    .field { margin-bottom: 14px; }
    .card input[type="text"], .card input[type="password"] {
      width: 100%;
      padding: 11px 14px;
      background: var(--lt-inset);
      border: 1px solid var(--lt-line);
      border-radius: 9px;
      color: var(--lt-text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .card input::placeholder { color: #9aa3b8; }
    .card input[type="text"]:focus,
    .card input[type="password"]:focus {
      border-color: var(--accent);
    }
    .card input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 11px;
      margin-top: 4px;
      background: var(--accent);
      border: none;
      border-radius: 9px;
      color: #fff;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .card button[type="submit"]:hover { background: #5d8dfe; }
    .card button[type="submit"]:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .card button[type="submit"]:disabled {
      background: #b6c4e4;
      cursor: not-allowed;
    }
    .error {
      color: var(--danger);
      font-size: 0.82rem;
      min-height: 1.3em;
      margin-bottom: 10px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
      .tile { opacity: 0.9; }
    }

    /* ---- narrow screens: dark story stacks on top of the form ---- */
    @media (max-width: 880px) {
      .split { flex-direction: column; }
      .pane--dark { flex-basis: auto; overflow: visible; }
      .pane-content {
        min-height: 0;
        padding: 36px 28px 30px;
      }
      .features { margin-top: 28px; gap: 14px; }
      .footnote { position: static; margin-top: 24px; }
      .loaded { position: static; margin-top: 10px; }
      .tile { display: none; }
      .pane--light { padding: 36px 24px 44px; }
      .ghost, .slots { display: none; }
    }
`

const PLUG_SVG = `
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
        stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">
        <path d="M9 7V3" /><path d="M15 7V3" />
        <path d="M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7z" />
        <path d="M12 16v5" />
      </svg>`

interface PageOptions {
  title: string
  heading: string
  subtitle: string
  fields: string
  script: string
}

/** Shared page shell: dark DSH story pane + light form pane. */
function renderPage(opts: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="split">
    <section class="pane pane--dark" id="paneDark">
      <div class="board-bg" aria-hidden="true"></div>
      <div id="board" aria-hidden="true"></div>
      <div class="pane-content">
        <header class="brand">
          <div class="brand-row">${PLUG_SVG}<div class="wordmark">DSH</div></div>
          <p class="kicker">多用户登录网关，而这道门本身也是一个插件。</p>
          <p class="lead">DSH 的 Web GUI 按「单用户、localhost」设计——一旦暴露到网络，任何人都能打开它。dsh-login 加一道登录墙，把它变成安全的多用户部署。</p>
        </header>
        <ul class="features">
          <li><i></i><div><b>登录墙</b><span>页面、静态资源、API 与 WebSocket 全部要求有效会话，未登录一律回到这道门</span></div></li>
          <li><i></i><div><b>会话隔离</b><span>普通用户只看到自己的对话、子代理与工作区；凭据、宿主设置等管理域整体禁用</span></div></li>
          <li><i></i><div><b>用户管理</b><span>管理员在 设置 → 用户管理 新建、重置密码、禁用、删除，操作立即吊销该用户的会话</span></div></li>
          <li><i></i><div><b>远程友好</b><span>frp、隧道或局域网访问，登录一次即自动信任主机，无需手动改配置</span></div></li>
        </ul>
      </div>
      <div class="footnote">密码以 scrypt 哈希存储，会话 Cookie 为 HttpOnly，重启后登录依然有效。</div>
      <div class="loaded"><i></i>dsh-login 已加载</div>
    </section>
    <section class="pane pane--light">
      <div class="ghost ghost--g1" aria-hidden="true"></div>
      <div class="ghost ghost--g2" aria-hidden="true"></div>
      <div class="ghost ghost--g3" aria-hidden="true"></div>
      <div class="slots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div class="card">
        <h1>${opts.heading}</h1>
        <div class="subtitle">${opts.subtitle}</div>
        <div class="error" id="error" role="alert"></div>
        <form id="authForm">${opts.fields}</form>
      </div>
    </section>
  </main>
  <script>${opts.script}</script>
  <script>${BOARD_JS}</script>
</body>
</html>`
}

/** Login page: username + password, POSTs {username, password}. */
export function renderLoginPage(): string {
  return renderPage({
    title: 'DSH 登录',
    heading: '登录 DSH',
    subtitle: '多用户网关：每人独立会话，权限各归其位。',
    fields: `
        <div class="field">
          <input type="text" name="username" id="username" placeholder="用户名"
            autocomplete="username" autofocus required>
        </div>
        <div class="field">
          <input type="password" name="password" id="password" placeholder="密码"
            autocomplete="current-password" required>
        </div>
        <button type="submit" id="submit">登录</button>`,
    script: `
    var form = document.getElementById('authForm');
    var username = document.getElementById('username');
    var password = document.getElementById('password');
    var error = document.getElementById('error');
    var submit = document.getElementById('submit');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '验证中…';
      try {
        var res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = '用户名或密码错误';
          password.value = '';
          password.focus();
        } else if (res.status === 400) {
          error.textContent = '请求无效';
        } else if (res.status === 500) {
          error.textContent = '尚未创建任何用户，请刷新页面完成初始化';
        } else {
          error.textContent = '未知错误';
        }
      } catch (err) {
        error.textContent = '网络错误，请重试';
      } finally {
        submit.disabled = false;
        submit.textContent = '登录';
      }
    });`,
  })
}

/** First-time setup page: creates the admin account via {username, password}. */
export function renderSetupPage(): string {
  return renderPage({
    title: 'DSH 初始化',
    heading: '初始化 DSH',
    subtitle: '创建第一个账户，它将自动成为管理员。',
    fields: `
        <div class="field">
          <input type="text" name="username" id="username" placeholder="用户名"
            autocomplete="username" autofocus required>
        </div>
        <div class="field">
          <input type="password" name="password" id="password" placeholder="设置密码"
            autocomplete="new-password" required>
        </div>
        <div class="field">
          <input type="password" id="confirm" placeholder="确认密码"
            autocomplete="new-password" required>
        </div>
        <button type="submit" id="submit">创建账户</button>`,
    script: `
    var form = document.getElementById('authForm');
    var username = document.getElementById('username');
    var pw = document.getElementById('password');
    var cf = document.getElementById('confirm');
    var error = document.getElementById('error');
    var submit = document.getElementById('submit');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      error.textContent = '';
      if (username.value.length < 1) {
        error.textContent = '用户名不能为空';
        return;
      }
      if (pw.value.length < 1) {
        error.textContent = '密码不能为空';
        return;
      }
      if (pw.value !== cf.value) {
        error.textContent = '两次输入的密码不一致';
        cf.value = '';
        cf.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '创建中…';
      try {
        var res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: pw.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 403) {
          error.textContent = '初始化已完成，请直接登录';
        } else if (res.status === 400) {
          error.textContent = '请求无效（用户名限字母、数字、下划线和连字符，最长 32 位）';
        } else {
          error.textContent = '未知错误';
        }
      } catch (err) {
        error.textContent = '网络错误，请重试';
      } finally {
        submit.disabled = false;
        submit.textContent = '创建账户';
      }
    });`,
  })
}
