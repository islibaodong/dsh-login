# Memory Changelog

## 2026-08-18 — Multi-user gateway (feat/multiuser-isolation)
- Multi-user auth: UserStore (scrypt, `${password}_USERS` credential ref),
  admin bootstrap on first visit, `/admin` page + `/api/auth/admin/*` routes,
  `/api/auth/me`; legacy single password no longer authenticates.
- Identity-aware `/api` carrier takeover: `connection.ts` child plugin
  (prefix route + WS upgrades), `api-filter.ts` per-user proxy with
  allow-list + ownership filtering, `ownership.ts` sessionId→username
  sidecar; `cordis.patch.yml` disables the shipped `web-runtime` and
  `connection` rows; browser half shipped as `dist/client.js`
  (`connection.client.ts`, `scripts/build-client.mjs`).
- Memory files rewritten to match (architecture/modules/api/gotchas).

## 2026-08-18 — Initial analysis
- Full codebase analyzed and memory files written
- 3 modules mapped, 0 endpoints documented, 0 models captured
