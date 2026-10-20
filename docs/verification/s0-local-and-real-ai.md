# S0 验证记录（Issue #2）

2026-10-18。在本地真实 Worker、D1、每会话 SQLite Durable Object 上验证；不包含生产部署验收。

2026-10-19 追加：下表原有的每会话历史及上下文固定门槛已被[自动摘要与滑动窗口](chat-compaction.md)替代；本页保留最初 S0 验证证据，当前阈值见该记录和 `src/lib/limits.ts`。

## 已验证

- `pnpm check`：格式、两种语言键一致、基础契约和 Worker 集成、类型检查。Worker 52 项通过；官方契约另有 1 项 activities 用例明确跳过，因为本产品不提供该可选存储；generationRuns、ArtifactStore、BlobStore 亦明确排除，不将这些空跑用例算作能力通过。单元契约 5 项通过。
- `pnpm test:workers`：四个官方持久化状态存储的 conformance，以及 D1 batch 整批回滚、条件更新冲突、消息整批替换、数据集隔离、过期/失效凭据拒绝。
- 受保护 API：真实 JWT 验签，覆盖签名、issuer、audience、过期、空 subject、错误类型、service token、非本人及缺配置；伪造历史、跨源写入、超大输入拒绝。
- 本地 DO：持有活动回合至流与持久化结束；重复输入只返回收据，变更内容冲突；D1 接纳失败不调用模型；DO 接纳后、D1 接纳前故障，经真实 eviction 后仍保持互斥，超时回收后只有明确重试才调用模型；超时撤销后迟到输出不能写入，旧 alarm 不终止新回合。
- `pnpm e2e tests/e2e/probe.spec.ts`：桌面 Chromium 和 Pixel 7，发送、工具调用、备注、刷新 D1 回读、新会话、中英切换、窄屏无溢出。运行生产构建与真实本地 D1/DO；AI 为受控替身。
- `node scripts/real-ai-smoke.mjs`：单独读取忽略的本机配置，使用合成账目；真实服务 3 次请求通过鉴权、SSE、工具调用、备注保留、连续追问、受保护回读及 D1/DO 保存。存储为临时本地数据库。公开记录不包含个人端点、模型标识、凭据或原始响应。
- `pnpm build` 与 `node scripts/check-private-output.mjs`：生产构建、源代码/公开资源/测试/文档/构建输出的私密配置扫描通过。Cloudflare Vite 插件默认复制本地 `.dev.vars`，构建末端已排除该资产；发布产物不携带该文件。

## SDK 与边界

采用 `@tanstack/ai 0.69.0`、`@tanstack/ai-openai 0.30.0`、`@tanstack/ai-react 0.30.4`、`@tanstack/ai-persistence 0.9.0`。使用兼容服务工厂、显式纯文本/流式/函数调用能力、官方 SSE、React useChat 和官方持久化中间件；以所安装版本源码和随包 skill 为准。新测试插件为 `@cloudflare/vitest-plugin 1.4.4`，适配当前 Vitest 4，测试配置完全采用合成绑定，不读取本机 Secrets。

D1 历史逐条保存完整 ModelMessage，替换操作在单个原子 batch 内完成。每轮由应用先保存输入、请求摘要、回合和许可，再调用模型；中间件的尽力保存不是接纳收据。DO 协调状态与 D1 无跨存储事务，故障不确定期保持忙碌至许可截止，不自动重新调用外部模型。正常输出/收尾检查活动数据集、会话、回合、随机许可及数据库时钟有效期。

## 技术阈值

| 对象 | 上限及处理 |
| --- | --- |
| 单笔原币与主币金额 | 各 9,000,000,000,000 最小单位，必须为安全整数；中间换算用 BigInt 有理数，最终半入到币种最小单位。查询合计也须检测安全范围。 |
| 币种精度 | 冻结支持清单；JPY/KRW/ISK 为 0 位，BHD/JOD/KWD/OMR/TND 为 3 位，其余支持币种为 2 位。ECB 无相应报价时保留待补，并允许手填或实际结算；不会改用其他报价来源。 |
| 手填汇率 | 正十进制，至多 12 位小数、整数部分至多 9 位；原币→主币方向固定，使用精确有理数。最终金额超范围拒绝。 |
| 单轮输入 / 逐笔备注 | 4,000 / 2,000 字符；不静默截断。 |
| 普通 JSON 请求 | UTF-8 64 KiB，在模型调用或业务修改前拒绝超限。 |
| 完整会话 | 1,000 条消息 / UTF-8 1 MiB，逐行存储；超限不覆盖原历史。 |
| 本轮模型上下文 | 40 条消息 / UTF-8 32 KiB；达到限制提示新建会话，不截断保存的历史。 |
| 单回合 | 90 秒；DO alarm 与 D1 许可到期双重保护。模型自动重试关闭。 |
| JSON 备份 | UTF-8 10 MiB / 100,000 条业务记录；预览前校验，失败不部分替换。 |

金融、备份阈值是后续各业务任务需沿用的边界；本 S0 页面只验证合成费用，不提供正式入账。当前产品只启用聊天所需存储，不包含生成媒体或字节资产存储。

## 运行方式与未执行范围

`pnpm build` 后，`node scripts/local-test-server.mjs` 提供仅监听回环地址的合成身份/模型浏览器夹具。它不读取 `.dev.vars`，禁止真实外网；身份在内存中生成，生产代码仍走同一验签逻辑。真实服务联调必须显式执行独立脚本，脚本不打印配置、原始提示词或服务错误。

未创建真实云资源、未提交或推送、未生产部署、未验证线上 Access 策略。S0 不表示 Moni 全部业务功能已完成。构建目前保留第三方 Zod 注释和初始包体积提示，不影响通过结果。

参考：[Cloudflare Workers 测试](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[D1 原子 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[DO 测试工具](https://developers.cloudflare.com/durable-objects/best-practices/testing-with-durable-objects/)、[Frankfurter 币种和 ECB 来源选择](https://www.frankfurter.app/#filtering-by-provider)。

## 联调排错记录

HTTP 200 若返回 HTML 站点页面，并不代表模型协议可用；核对兼容 API 根路径后再验收 SSE 和工具调用。验证连续输出时，应先按官方 SSE 事件拼接文本 delta，再检查完整备注，不能直接在原始分片中查找完整词句。此记录不包含个人服务地址或配置。

浏览器夹具已统一为每份用例启动独立 D1/DO 运行时，`pnpm e2e` 先构建一次，再启动测试；不复用可能引用旧静态资源的长驻预览，也不依赖外部真实账本。
