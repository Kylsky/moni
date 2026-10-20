# Moni v0.1 部署指南

2026-10-19 更新。首次按钮部署、远端迁移、本人 Access、自定义域名与重复发布已实际验证；部署后网页配置 AI 与微信的追加需求见[网页配置设计](web-configuration.md)。验证层次见[部署记录](verification/deployment-readiness.md)。微信作为单独批准的可选扩展已提供本地接入实现，配置与待验收事项见[微信接入说明](wechat-integration.md)，不改动原 v0.1 的 19 项验收基线。

## 一键入口与默认资源

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/ISheepp/Moni) 从公开远端仓库复制项目并连接 Workers Builds。**只有已推送的版本进入按钮流程**；按钮显示不等于新版已上线，需核对代码版本及真实部署结果。

Worker 默认名 `moni`，保留 `workers.dev`。`DB` 绑定 D1；`CONVERSATIONS` 绑定本 Worker 导出的 SQLite `Conversation`，DO 迁移 `v1` 建立该类；`WECHAT` 绑定本 Worker 导出的 SQLite `WechatBot`，迁移 `v2` 建立该类。D1 使用 `migrations/` 有序迁移，`0015` 为会话增加来源及不参与业务备份的渠道执行授权，`0016` 增加同样排除业务备份的两档记账权限，`0017` 增加不参与业务备份的加密服务配置表。资源 ID 留给部署者账号创建／绑定，不提交个人 account ID、域名或数据库 ID。

构建为 `pnpm run build`，部署为 `pnpm run deploy`：Workers Builds 只构建一次，部署阶段按 **binding 名 DB** 运行远端迁移，再发布生成的 Worker，然后运行 `bootstrap-deployment-secrets.mjs` 准备加密密钥。脚本仅创建缺少的 `CONFIG_ENCRYPTION_KEY`／`WECHAT_SECRET`，已有值不读取、不替换、不输出。迁移失败即停止发布，不删除库或初始化已有账本。本机需要连同构建一起发布时使用 `pnpm deploy:local`；单独运行 `pnpm deploy` 要求已有当前目标的构建产物。依据：[官方部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

初次部署不要求 AI、微信或 Access Secret。官方按钮会自动读取仓库根目录 `.dev.vars.example`／`.env.example` 生成 Secret 输入，因此本项目将空白本地示例放在 `config/local.vars.example`，并让类型生成和 dry-run 显式读取该文件。`package.json` 中的绑定描述只说明用途，不携带个人配置。Access 在部署后的引导阶段完成；AI 和微信可跳过。

## 首次部署次序

1. 审查并发布代码到自己的仓库，确认公开材料没有私密文件。按钮使用该仓库，核对资源名称和命令。
2. 完成构建、资源、迁移、部署并分别记录结果。打开默认地址：身份未配置时，首页返回双语首次使用引导。它只检查账本数据库基本就绪和会话 binding 是否存在，不读取或显示私人账目，也不会调用 AI／微信。存储准备完成时首页为 HTTP 200，空库／迁移未完成／缺 binding 时为 HTTP 503，并说明修复步骤；业务接口始终拒绝未配置身份的请求。
3. 启用 Zero Trust，进入该 Worker 的 **Access**，选 **All traffic**。策略仅允许明确的本人身份；不要用整个邮箱域、所有账号成员或 Everyone 代替本人规则。必要时在 Zero Trust 应用中编辑为具体本人邮箱／身份提供者规则。
4. 将下表 Access 三项设为 Worker Secrets。`OWNER_SUBJECT` 取本人的 Zero Trust 用户 ID／已核实应用 token 的 `sub`；不把完整 JWT 发到聊天、公共解码站、文档或命令参数。无网页认领 owner 入口。
5. 本人登录后选主币、时区并初始化；正式账目出现后主币锁定，时区修改不改历史发生日。
6. 如需 AI，在“设置 → AI 助手”填写 API Key、Base URL、模型；可测试连接后保存。测试只请求简短合成文本，不保存配置、不读写账目，也不替代工具能力验收。微信在“设置 → 微信入口”扫码即可；可先绑定，再配 AI。两项均可跳过。
7. 用合成账目跑完线上验收，再录入私人数据。公开截图／日志只使用合成内容。

Worker 级 All traffic 保护同 Worker 的生产、预览及其他域名。应用仍校验 RS256 签名、issuer／AUD／有效期／应用 token／非空 subject 与唯一 owner。当前聊天为 HTTP SSE，不需要 WebSocket。依据：[Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。

首页引导不接受配置写入、密钥或 owner 认领。配置齐全后，未登录与非本人继续返回访问受限页面，不会因为存在引导而跳过 Access。主币／时区在本人验证后的既有初始化页面设置；AI Key 仅在本人验证后的设置页提交，保存后不回传；公开引导不接受 Key。

| Secret | 内容与边界 |
| --- | --- |
| `ACCESS_ISSUER` | 自己的 Access 团队 HTTPS origin，无路径／查询 |
| `ACCESS_AUDIENCE` | 保护该 Worker 的应用 AUD |
| `OWNER_SUBJECT` | 同 issuer 下唯一本人 sub；重建组织／删除重加用户后重新核实 |
| `CONFIG_ENCRYPTION_KEY` | 部署自动生成，AES-GCM 加密网页 AI 配置；不能随普通更新轮换 |
| `WECHAT_SECRET` | 部署自动生成，独立加密微信凭据；不能随普通更新轮换 |
| `AI_API_KEY` | 旧版部署／本地可选回退；网页保存或清除后不再回退 |
| `AI_BASE_URL` | 可选兼容服务 HTTPS base URL，按供应商保留 API 路径；无账号密码、查询或片段 |
| `AI_MODEL` | 可选实际模型 ID，与其他 AI 配置一起设置 |

可用控制台 Secrets 或以下交互命令，不在命令行传值：

```bash
pnpm exec wrangler secret put ACCESS_ISSUER
pnpm exec wrangler secret put ACCESS_AUDIENCE
pnpm exec wrangler secret put OWNER_SUBJECT
```

AI 配置默认通过网页管理，无需返回控制台填写。旧环境变量配置仍可作为未设置网页配置时的回退；网页清除会明确禁用 AI，不会复活旧 Key。主密钥丢失会使已保存配置不可读，账本备份不能恢复它；保留部署 Secrets，再次提交模型 Key 可重建 AI 配置。

加密准备失败时部署命令以失败退出；Worker 可能已上传，需核对目标和权限后重试，不能删除旧密钥。

先核对当前生成配置的 Worker 名称；preview 明确使用 `--config wrangler.jsonc --env preview`。Secret 不写入 `vars`，`.dev.vars` 不上传仓库／Issue／备份。业务备份白名单不含这些绑定。依据：[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 生产与预览隔离

此处 preview 为独立命名 Worker **`moni-preview`**，D1 默认名 **`moni-preview`**，DO 没有 `script_name`，属于独立 Worker namespace。单独配置 Access 应用／AUD、owner 及可选 AI Secrets；不能复制生产 D1 ID 或指向生产 DO script。

```bash
pnpm deploy:preview
```

该命令在**构建时**选择 `CLOUDFLARE_ENV=preview`；迁移、发布使用本次构建生成的平面配置。只在 deploy 时指定环境不能改变默认构建。两种构建共用 `dist/`，不要并行，不拿另一环境上次输出直接发布。依据：[Vite 的 Cloudflare 环境](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)。

自动版本／分支预览 URL 与独立 preview Worker 不同。不要假定自动预览 URL 有数据隔离；核实实际 D1／DO 绑定前不运行私人写入。每个 Worker 均设置 All traffic 并逐一验收。

## 本地配置与迁移

写真实 `.dev.vars` 前确认 `git check-ignore .dev.vars` 成功、`git ls-files .dev.vars` 为空；通过安全编辑器写入，权限为 0600。已有文件不要覆盖。示例保持空白，不写自己的服务地址／模型／身份。

本地示例位于 [`config/local.vars.example`](../config/local.vars.example)。它只作为开发配置参考与类型／dry-run 输入；不要重新在仓库根目录增加自动发现的 Secret 示例，否则部署按钮会再次展示这些配置项。

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

本地页面仍要求同一 Access 校验。自动化通过临时测试身份运行真实本地 D1／DO，模型、报价和时间可控，不读取开发私密配置。

本地迁移只写 `.wrangler/`。远端由部署流程执行 `wrangler d1 migrations apply DB --remote`；会改变所选数据库，须先核对目标并备份。失败只回滚当前迁移，之前成功的可能保留；不要删除库或清空 migrations 表重跑，排错后继续未完成迁移。依据：[D1 migrations apply](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply)。

如果直接用 CLI 首次部署而不走按钮，先由部署者创建 D1 并在自己的私密部署配置中绑定实际数据库，再执行 `pnpm deploy:local`；不能假定迁移命令会替你建库。原仓库保持无个人资源 ID 的默认示例。按钮流程则由平台先准备绑定资源；当前已有账号的真实按钮流程已验证，空白新账号的开户步骤仍需独立验收。

## 绑定自己的域名

默认地址验收后，在该 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 添加自己的域名。域名需要属于该 Cloudflare 账号下的有效 zone；先检查目标主机名的已有记录，不覆盖其他服务。Cloudflare 为 Custom Domain 创建 DNS 与证书。

自定义域名在部署者的 Cloudflare 控制台维护，公共 `wrangler.jsonc` 不填写维护者域名、账号 ID 或私人配置。启用 Worker 级 **All traffic**，同时验收自定义域名、默认 `workers.dev` 与预览地址；再次部署后核实域名和保护策略仍在。依据：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 不触达云端的检查

```bash
pnpm cf-typegen
pnpm check
pnpm build
pnpm check:private
pnpm deploy:dry-run
pnpm exec playwright test
```

dry-run 使用空白示例生成本机部署包，不创建资源、迁移远端或发布；不等于 Access、线上功能验收。预览先 `pnpm build:preview` 再 dry-run；之后 `pnpm build` 恢复默认构建。绑定类型由空白示例生成，不手改。

## 真实服务检查

真实模型仅读取已忽略的本机 `.dev.vars`，只发合成账目。脚本默认跳过，必须显式选择。已有代理由本机 Node 环境设置，不写入项目。

```bash
MONI_REAL_AI_SMOKE=1 node scripts/real-ai-smoke.mjs
MONI_REAL_CHAT_SMOKE=1 node scripts/real-chat-smoke.mjs
MONI_REAL_DRAFT_SMOKE=1 node scripts/real-draft-smoke.mjs
MONI_REAL_QUERY_SMOKE=1 node scripts/real-query-smoke.mjs
MONI_REAL_FX_SMOKE=1 node scripts/real-fx-smoke.mjs
```

脚本通过编译后受保护 Worker 与临时 D1／DO，结束即销毁。模型 HTTP 成功还须核对完整流、工具、持久化、上下文及本人确认。汇率核对方向、两个日期、缺币对及备注修改不重取价。历史成功不替代部署后的网络验收。

## 线上验收与恢复

- 空白账号实际从 README 按钮确认创建，部署阶段不填写 AI／微信／Access Secret；记录 Worker、D1、DO、全部迁移、首页引导，再完成 All traffic、本人身份 Secrets 与账本初始化。按钮 UI 的实际表现必须由真实流程验收，不能用本地示例扫描代替。
- 未登录、错误 issuer／AUD／非本人，在默认、独立 preview 及其他启用入口均拒绝。私有响应 no-store／noindex、robots 禁止收录、sitemap 不列私人路径。
- 两环境用相同合成记录／会话 ID 写不同内容，各自读回，核对真实 D1 ID、DO namespace 不同，不能只看 Worker 名。
- AI 留空完成手动收支、备注搜索、统计、手填外币；再验证真实模型草稿和查账，确认前无正式入账。
- 下载 JSON 并核对，恢复先预览、保存现账、明确确认；失败保留完整原账，旧卡／请求拒绝。
- 记录实际版本、迁移、服务、浏览器及隐私证据后关闭 #20；父规格无单独指令不改写／关闭。

代码回滚不会自动回滚 D1 及已应用迁移。升级前私密保存业务 JSON 及必要 D1 管理备份，先在独立 preview 验证。日志仅固定状态码／错误分类，不输出 Key、JWT、私人输入、完整备注或原始供应商错误。
