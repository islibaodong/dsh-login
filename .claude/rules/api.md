# API Surface

Auth routes are exact-path WebRoutes on `ctx.webServer` (cookie-authenticated,
8KB JSON body cap). The `/api` carrier is a prefix route + two WS upgrade
paths registered by the connection child plugin.

## Routes
| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/login` | none | HTML login page; admin-bootstrap setup form if no users exist |
| POST | `/api/auth/setup` | only while user store empty | Body `{username,password}` → create forced-admin + login; 403 once any user exists |
| POST | `/api/auth/login` | none | Body `{username,password}` → verify vs UserStore → session cookie; 401 invalid; 500 no users |
| POST | `/api/auth/logout` | session cookie (optional) | Revoke token, clear cookie |
| GET | `/api/auth/me` | session cookie | `{username,isAdmin}`; 401 without session |
| GET/POST | `/api/auth/admin/users` | admin | GET list (`{users:[{username,isAdmin,createdAt}]}`); POST create `{username,password,isAdmin?}` (409 exists, 401/403 gate) |
| POST | `/api/auth/admin/users/password` | admin | `{username,password}` → reset (404 unknown user) |
| POST | `/api/auth/admin/users/remove` | admin | `{username}` → remove; 409 refuses the last admin |
| GET | `/admin` | admin session | Management page HTML; 302 `/login` otherwise |
| ANY | `/api` (prefix) | host trust + `dsh_session` cookie | Carrier takeover: 403 untrusted host, 401 no session, 426 plain GET on event paths, 403 non-allowed method (non-admin), per-user dispatch otherwise |
| WS | `/api/events.mux`, `/api/events.host` | host trust + cookie on upgrade | Per-user, ownership-filtered downlinks |

## GET/HEAD fallback (gateway)
`dsh_session` cookie required: 302 `/login` unauthenticated; else static dist;
other methods 405.

## Cookie
`dsh_session=<hex64>`; HttpOnly; SameSite=Strict; Path=/; Max-Age=sessionTtl.

## Status codes
400 bad JSON/body; 401 missing/invalid session or credentials; 403 setup after
users exist / non-admin on admin routes / forbidden wire method or host;
404 unknown user or missing apiProxy; 405 non-GET/HEAD on fallback; 409 user
exists or last-admin removal; 426 plain GET on event paths; 500 no users
configured / store failure.
