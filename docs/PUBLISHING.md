# 发布手册：插件市场收录 + npm 发布

> 实战沉淀于 2026-08-21 ~ 08-27 的首次发布（PR [awesome-dsh-plugin#2555](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2555) + npm `@islibaodong/dsh-login@0.1.0`）。
> 后续再发新插件、或更新本插件时照此清单走，可避开我们踩过的每一个坑。

---

## 一、发布到插件市场（awesome-dsh-plugin）

### 硬性要求（CI 自动查）

| 要求 | 我们的解法 | 坑点 |
|---|---|---|
| `package.json` 声明 `dsh.bundle.patch` | 已声明，指向 `./cordis.patch.yml` | **最常见的被拒原因**：只声明 `dsh.client` 不可安装。dsh.client 仅带浏览器 UI 时才需要 |
| 仓库 ≥1 天且 ≥10 commits | 天然满足 | 建好后先把功能做完再提 PR |
| repo 加 `dsh-plugin` topic | `gh repo edit --add-topic dsh-plugin` | 忘加会卡在评审 |
| 描述只说功能、必须与代码一致 | en/zh 描述逐句对照过源码 | **夸大是 otherwise-good 插件被打回的第一原因**；描述含 `: （冒号+空格）必须加引号，否则 YAML 解析炸 |
| 分类贴合实际功能 | `security`（与 dsh-auth-gateway 同类但差异化：我们是多用户+会话隔离，它是单用户+TOTP） | 分类不准不会被拒，维护者直接改 |
| 一个 PR ≤3 条 | 我们只有 1 条 | 多插件要拆 PR |

### 流程（照抄可用）

```bash
# 1. fork awesome-dsh-plugin/awesome-dsh-plugin 并 clone
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
git clone https://github.com/<you>/awesome-dsh-plugin.git && cd awesome-dsh-plugin
git remote add upstream https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git

# 2. ⚠️ 先 fetch 最新的 upstream/main，从它切分支（见下方坑 1）
git fetch upstream main --unshallow   # 浅克隆必须补全历史，否则 fetch 会抖
git checkout -B add-<plugin> upstream/main

# 3. 写条目文件：data/plugins/<owner>__<repo>.yml
cat > data/plugins/islibaodong__dsh-login.yml <<'EOF'
url: https://github.com/islibaodong/dsh-login
name: islibaodong/dsh-login
category: security
description:
  en: 'Multi-user login gateway for the DSH web UI: the first visit creates the admin account, admins add and manage users in the GUI settings panel, ordinary users see only their own conversations, and unauthenticated visitors are redirected to /login.'
  zh: '为 DSH Web 界面提供多用户登录网关：首次访问创建管理员账户，管理员在 GUI 设置面板中添加和管理用户，普通用户只能看到自己的会话，未登录访问重定向到 /login。'
EOF

# 4. 截图：不要动市场的 data/screenshots.json（见坑 2）！
#    在插件自己仓库根放 screenshots.json（相对路径）：
#    ["images/login.png", "images/users.png"]

# 5. 重新生成两个 README（README 是生成物，禁止手编）
npm ci && node scripts/generate-readme.mjs

# 6. 本地预演 CI（四项全过再推）
node scripts/generate-readme.mjs --check          # README 同步
npx awesome-lint README.md                        # 注意：Windows 绝对路径会误报
                                                  # "Invalid GitHub repo URL"（盘符冒号
                                                  # 被当 URL scheme），用相对路径跑
SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs # 站点构建 + 截图校验
GITHUB_TOKEN=$(gh auth token) node scripts/check-submission.mjs --base upstream/main
                                                  # Windows 下此脚本路径比较 bug（正/反斜杠），
                                                  # 用 --only-list 文件绕过

# 7. 提交推送开 PR（一个 PR 的 diff 应该只有：yml + 2 个 README）
git add -A && git commit -m "Add <owner>/<repo>"
git push -u origin add-<plugin>
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --base main \
  --head <you>:add-<plugin> --title "Add <owner>/<repo>" --body-file pr-body.md
```

### 踩过的坑（按痛的程度排序）

1. **分支基底污染**：我们从 main 拉分支时恰逢 main 短暂带过一批后来被 revert 的
   site/ 广告位实验代码，PR 于是带着 `site/assets/ads.txt` 等文件 → 触发
   `Repository config guard` 失败，维护者挂起 PR。**解法**：永远从最新
   `upstream/main` 重建分支（`git checkout -B <branch> upstream/main`），
   只把自己的文件带回来。**不要用 GitHub 的 Sync fork 按钮**（merge 进来会把
   已撤销的改动留在分支上）。修复后 force-push，PR 自动更新。

2. **共享文件冲突**：`data/screenshots.json` 所有投稿人共用且无排序，108 个
   PR 在抢同一处，先合的让其余全部 rebase。**现行做法**（维护者 2026-08-26 起）：
   截图在插件自己仓库根目录放 `screenshots.json`（相对路径数组），
   好处是换图只需 push 自己仓库、不再提 PR。market 端的旧机制仍兼容但别再用。

3. **市场搜不到 ≠ 需要发 Release/tag**：CI 通过（绿色 ✅）只是合并的**前置条件**，
   合并由维护者人工评审（会实际读源码核对描述的每一句）。收录列表
   （= 市场可搜索）完全取决于 PR 是否合并。tag/Release/tarball 只是可选的
   安装体验加分项，仅当仓库无法源码安装时才必须。

4. **网络抖动**：GitHub API（TLS EOF）和 npm registry 都会间歇抖，
   所有 gh/curl/pnpm 操作包一层重试循环。

5. **维护者反馈很快且具体**：会以 PR 评论给出精确改法（我们遇到两次：分支重建、
   截图机制变更）。照做 → force-push → 评论里 ping 他（他会 first review）。

---

## 二、npm 发布（可选，但推荐）

> 好处：市场自动显示下载量排序；安装免 allowBuilds 构建授权。
> 收录与 npm **无关**——不发 npm 照样能被收录，GitHub 安装照常。

### 一次性准备

1. **`package.json` 必须有 `repository` 字段回指本仓库**——市场 probe-npm 靠它自动
   建立 GitHub↔npm 映射；没有它两者不关联。
   ```json
   "repository": { "type": "git", "url": "git+https://github.com/islibaodong/dsh-login.git" }
   ```
2. **`files` 白名单**（不带就整个仓库进包）：
   ```json
   "files": ["src", "dist", "cordis.patch.yml", "screenshots.json", "LICENSE", "README.md", "README.zh.md"]
   ```
3. 预构建产物必须已提交（我们的 `dist/client.js` 在 git 里，无构建脚本 → 源码/npm
   安装都不需要 allowBuilds）。

### 发布命令

```bash
npm pack --dry-run        # 先看包内容（23 文件 / 120.9 kB 为正常）
npm publish --access public --registry=https://registry.npmjs.org
```

### 坑点

1. **默认 registry 是镜像**：本机 npm 默认指向 npmmirror.com，镜像不能登录/发布。
   一切命令显式加 `--registry=https://registry.npmjs.org`。

2. **2FA / 403 Forbidden**：账号开了 2FA 时，`publish` 报
   `Two-factor authentication or granular access token with bypass 2fa enabled`。
   - `--otp=<6位码>` 只对验证器 App 的 TOTP 有效（注意是 **6 位**，不是 8 位恢复码）
   - 没有验证器 App 时走 **granular access token**：
     npmjs.com → Settings → Access Tokens → Granular Access Token：
     Read and write + 勾 `@islibaodong` scope + **启用 bypass 2FA**。
     然后临时 npmrc 发布（用完即删 + 网页端 Revoke token）：
     ```bash
     cat > .npmrc.publish <<EOF
     //registry.npmjs.org/:_authToken=npm_xxx
     EOF
     npm publish --access public --registry=https://registry.npmjs.org --userconfig .npmrc.publish
     rm .npmrc.publish
     ```
   - 环境变量方式 `NPM_CONFIG_//registry.../:_authToken` 在 bash 里非法（变量名带斜杠），
     必须走 npmrc 文件。

3. **scope 包必须 `--access public`**（`@islibaodong/dsh-login` 默认会按私有包计费拒绝）。

4. 发布后无需通知市场：probe-npm 从 registry 自动采集，**yml 里手写 `npm:` 字段
   会被校验拒收**。

---

## 三、发新版本（更新流程）

- **代码更新**：commit + push 即可；npm 用户要发新版本：bump version → publish。
  GitHub 安装用户跑 `dsh plugin --profile web update` 才会拉新 commit。
- **换截图**：只改本仓库 `screenshots.json` / `images/`，push 即可，无需市场 PR。
- **改市场描述/分类**：改自己那条 `data/plugins/<slug>.yml` → 重新生成 README → PR。
  **绝不动别的条目**（gate 会列出 PR 修改的每个既有条目）。

---

## 四、相关的其它坑（harness 兼容）

- **harness 升级可能静默破坏插件**：0.1.0-rc.8 → 0.1.1-rc.1 时，
  `applyIndexTaps`（旧 API）语义变化导致登录后
  `window.__ModuleLoader__ bootstrap facade is missing`。
  gateway 已改为优先 `renderIndex`、回退 `applyIndexTaps`（commit c043090）。
- **本机 harness 以 src/tsx 模式直跑**（`node --import tsx/esm apps/cli/src/bin.ts`）：
  git pull 后重启立即生效，**lib/ 构建产物可能滞后**——vitest 须把 webserver/
  frontend-static 别名到 checkout 的 src（见 vitest.config.ts），否则测试跑的是旧 lib。
- **peerDependencies 与预发布版本**：`>=0.1.0` 这类范围**静默排除一切 prerelease**
  （node-semver 规则：预发布版本只能被同 major.minor.patch 元组且带 prerelease 标签的
  比较符匹配）。harness 实际以 0.1.0-rc.x / 0.1.1-rc.1 发布，须写成显式分支：
  `">=0.1.0-rc.1 <0.1.1 || >=0.1.1-rc.0 <0.2.0-0"`（commit 1941096）。
