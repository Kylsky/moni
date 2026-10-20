# 首次部署准备验证

2026-10-19。范围：README 官方部署按钮、构建／迁移顺序、无私密配置的首次打开与 Access 保护边界。最初准备部分为本地证据；下方已追加经授权的真实部署结果。Issue #20 保持未完成，不能据此宣称全部 v0.1 验收通过。

## 已确认的问题与修复

- 根目录 `.dev.vars.example` 会被官方按钮发现为 Secret 配置项，与“先部署，AI／微信稍后配置”的流程冲突。空白示例移到 `config/local.vars.example`，类型生成与 dry-run 显式引用；根目录 `.dev.vars*` 全部忽略。没有读取、移动或改写真实 `.dev.vars`。
- Workers Builds 会分别识别 `build` 与 `deploy`，原 `deploy` 再构建一次。现在 `build` 负责构建，`deploy` 只按 `DB` binding 迁移再发布；本机完整发布使用 `deploy:local`，preview 复用同一流程。
- 初次打开只有“配置未完成”，缺少下一步。现在仅在首页 GET／HEAD 且 Access 缺配置时显示双语引导，检查数据库基本就绪与会话 binding。数据库探测要求有最后一份迁移的 `posting_policy` 和活动账本关联，不展示查询值。
- 存储准备完成时首页 HTTP 200；空库、部分迁移或缺 binding 时 HTTP 503 并显示修复说明。引导仅只读，不接受 Key、身份认领或配置写入。其他业务请求保持拒绝；身份配置齐全后的匿名／非本人路径不变。

官方依据：[Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Worker 级 Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。官方按钮支持自动创建 D1／DO、识别根目录示例与自定义部署脚本；不据此宣称本人 Access 策略已经自动创建。

## 本轮执行结果

| 验证 | 结果 |
| --- | --- |
| 部署命令与受限页单元用例 | 4 项通过；用临时替身执行实际 deploy 脚本，证明先迁移后上传，迁移失败不上传；未触达云端 |
| 受保护 API、部署状态与升级 | 25 项通过；真实本地 D1／DO，覆盖无 AI／微信／身份配置、空库、部分迁移、完成迁移恢复、缺 binding、HEAD 不改账本 |
| 手机／PC 部署相关浏览器验收 | 8 项通过；真实编译后 Worker，覆盖默认与中文首页、深浅主题、320px、引导重试、初始化前拦截；配置身份后的无 AI 手动外币、备注筛选、统计和备份亦通过 |
| 独立空库 Wrangler 迁移 | 16 份迁移全部通过；同一临时库第二次运行返回无待执行迁移；临时目录随后清理，未触碰开发库或远端 |
| 默认生产构建与类型 | Vite 客户端／服务端产物构建成功；首次尾部类型检查发现新增测试的子进程空环境缺少生成类型字段，补齐空值后单独 `tsc --noEmit` 通过，生产源未再变化，未重复打包 |
| Wrangler dry-run | 通过；D1、Conversation、WechatBot 绑定齐全，gzip 约 822.47 KiB，只在本机打包，未上传 |
| 格式与翻译 | 本轮相关文件格式检查通过；526 个中英键一致；引导沿用现有服务端双语受限页，不新增翻译键 |
| 隐私 | `check:private` 通过；源码、素材及构建产物无本机私密配置；`.dev.vars` 仍被 Git 忽略 |

定向复验入口：

```bash
pnpm exec vitest run tests/unit/deployment-config.test.ts tests/unit/restricted.test.ts
pnpm exec vitest run --config vitest.workers.config.ts tests/worker/deployment.test.ts tests/worker/api.test.ts tests/worker/upgrade.test.ts
pnpm exec playwright test tests/e2e/release.spec.ts --workers=2
pnpm exec tsc --noEmit
pnpm deploy:dry-run
pnpm check:private
```

浏览器和 dry-run 读取当前构建产物，源代码变更后需要先构建。本轮没有重跑全部会话／财务套件或全部浏览器用例，没有重新构建 preview，没有调用真实模型或微信；这些均不记为本轮通过。

## 授权后的发布检查

使用者随后明确授权发布并完成真实部署验收。发布前补跑一次完整 `pnpm check`：格式、526 个中英键、44 项单元、395 项本地真实 D1／DO 用例及类型检查通过；1 项可选 SDK activities 用例跳过。原有双端全量浏览器留给 GitHub CI 执行，部署相关 8 项浏览器已在本机通过。CI 复用已有构建运行浏览器验收，避免 `build` 后再次执行会重建的 `e2e` 包装命令。

## 已完成的真实首次部署

2026-10-19，经使用者授权提交并推送后，实际点击 README 官方按钮完成部署，不是 CLI dry-run 的替代证明。

- 已发布初版代码提交 `463977b7d2b22ca8dda5c86f8829b12242113aae`。其 [GitHub CI](https://github.com/ISheepp/Moni/actions/runs/39226545064) 完整通过：44 单元、395 Worker、72 手机／PC 浏览器；1 项可选 SDK activities 跳过。
- 按钮实际连接 GitHub，创建私有部署副本、D1 和 Conversation／WechatBot 两个 SQLite DO；构建日志确认只执行一次 build，然后完成迁移和发布。未填写 AI、微信或 Access 配置。
- 未配置身份时，真实默认／中文首页 HTTP 200，展示通用部署引导；业务状态、设置、账目接口 HTTP 503 `access_not_configured`，没有公开账目或认领入口。
- 远端只读查询确认原 16 份迁移已应用，最后为 `0016_posting_policy.sql`。此为首次部署版本；网页配置版本另增加 `0017`。
- 已配置 Worker 级 All traffic，仅允许已核实本人的邮箱，并绑定准确 owner subject。应用和专用策略均为 Cloudflare 的 1 month（730h）；实际登录凭证的有效时长核对为 730 小时。没有调整其他应用或组织全局设置。
- 已绑定部署者指定的自定义域名。自定义、默认和版本预览地址的匿名／伪造身份请求均跳转 Access；本人登录后设置接口 HTTP 200，能够初始化 CNY／Asia Shanghai。
- 真实界面写入一笔合成午餐，金额 35 元并保留独立备注；备注筛选、基础统计及 CSV 导出通过。创建合成会话并读取历史，触发真实云端会话 DO 协调。
- 使用已有构建再次经 Wrangler 发布，远端无待执行迁移；重新读取确认域名、Access Secrets、合成账目、备注及会话均保留。此重复发布走 CLI，首次 README 按钮构建页的重试点击未形成新的构建，不能将其记为第二次按钮构建成功。
- 首次部署和重复发布均未启用真实模型或绑定微信。原本“稍后配置”仍需手动 Secrets 的缺口，由使用者随后明确要求改为网页配置；追加实现、测试及边界见[网页配置设计](../web-configuration.md)。

## 尚待验收与状态边界

- 新版网页 AI 配置、微信自动加密准备、模型和微信的云端实际使用需按对应版本单独记录，不拿本机替身当线上成功。
- 独立 preview Worker 的真实数据隔离、云端真实模型财务工具、汇率报价可达性、微信持续轮询与费用仍未完成全部验收，因此 Issue #20 及原有真实服务阻塞保持开放。
- 首次部署测试的一笔合成账目和一个空会话暂未清理；浏览器随后由使用者接管，未绕过控制权执行恢复。清理时必须核对是否新增了本人数据，不能直接恢复旧空备份覆盖。

账号、个人域名、实际资源 ID、模型配置、二维码与密钥不写入公共默认配置或此记录；原始日志和个性化部署配置只保留在被 Git 忽略的私密目录。
