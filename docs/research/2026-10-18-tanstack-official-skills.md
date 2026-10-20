# TanStack AI 官方技能复核

日期：2026-10-18。范围：复核现有技术方案与实施计划，不改变 `PRODUCT.md` 及两份 ADR，不安装业务依赖、不写业务代码。

## 1. 证据基线与发布状态

本轮先读取项目内已下载的官方 `tanstack-ai`、`ai-core`、`ai-persistence` 入口，以及 chat-experience、client-persistence、tool-calling、structured-outputs、adapter-configuration、locks、persistence server/stores/build-cloudflare-adapter。下载来源固定为 [TanStack/ai commit 85c2956](https://github.com/TanStack/ai/tree/85c2956c68f3226ef409b3a4e54d5be82198931e)。随后对照该提交源码、官网和官方 npm registry 的元数据；没有下载或安装 npm 业务包。

官方 npm registry 的只读查询结果如下；它们是本次查询时的 `latest`，不是已安装版本或稳定性保证：

| 包 | 已发布 latest | 最近修改时间（UTC） | 重要兼容信息 |
| --- | --- | --- | --- |
| `@tanstack/ai` | `0.69.0` | 2026-10-13 17:52:19 | 元数据包含 `./locks` 导出。 |
| `@tanstack/ai-react` | `0.30.4` | 2026-10-13 17:48:28 | peer `@tanstack/ai: ^0.69.0`、React/Types React >=18；`@mcp-ui/client: ^7` 与 `react-dom` 均为 optional peer。 |
| `@tanstack/ai-openai` | `0.30.0` | 2026-10-13 17:48:23 | peer `@tanstack/ai: ^0.69.0`；元数据包含 `./compatible` 导出。 |
| `@tanstack/ai-persistence` | `0.9.0` | 2026-10-13 17:48:27 | peer `@tanstack/ai: ^0.69.0`；`vitest: ^4.1.10` 为 optional peer，导出 `./testkit`。 |

来源：[core registry](https://registry.npmjs.org/@tanstack%2Fai)、[React registry](https://registry.npmjs.org/@tanstack%2Fai-react)、[OpenAI registry](https://registry.npmjs.org/@tanstack%2Fai-openai)、[persistence registry](https://registry.npmjs.org/@tanstack%2Fai-persistence)。同提交的四个 package.json 声明版本与此表一致。

`ai-core` 技能的 `library_version: 0.42.0`、persistence 技能的 `0.0.0` 与真实 package.json/发布元数据不一致。因此不能据技能 frontmatter 判断 persistence 未发布，也不能把它当“稳定 0.0.0”。本次确认 **persistence 已发布 0.9.0**，但未验证包安装、产物与该提交逐字一致、Workers 运行或真实服务兼容性。没有 MCP UI 需求时，不因 optional peer 默认添加其依赖。

## 2. 消息协议：技能存在冲突，源码优先

### 已确认事实

- persistence 根技能第 143–153 行将非空 `messages` 描述为完整历史覆盖，甚至写着不能发 delta；同目录 server 技能第 76–85 行则描述按 ID 合并。前者不能直接作为当前实现依据。
- [merge-stored.ts](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/merge-stored.ts#L3) 的实现是：空 incoming 保留 stored；非空 incoming 取“最后一个已存在 ID”为截断点；同 ID 的 incoming 覆盖原消息；新消息追加。因此转发伪造旧 ID 可以覆盖消息或截断后续历史。
- `MessageStore.saveThread` 的**完整替换语义仍然正确**，它与 middleware 先合并不是矛盾：合并在 middleware，store 只保存收到的完整结果。[types.ts:81–124](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/types.ts#L81)
- AG-UI 参数助手执行结构校验，仍允许 system、assistant、tool 等协议角色；它不是 Moni 的权限或业务校验器。不能把解析后的对象不加筛选地展开到 `chat`。[chat-params.ts:19–127](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/utilities/chat-params.ts#L19)
- `persistence: true` 表示不在浏览器持久缓存并从服务端 hydrate，不代表客户端不发送历史；同提交 client 只有设置 `history.pageSize` 时才筛掉已知历史，普通模式仍返回完整列表；reload/continuation 又会发送最后一轮的切片。[chat-client.ts:3525–3550](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-client/src/chat-client.ts#L3525)、[官网 Client Persistence](https://tanstack.com/ai/latest/docs/persistence/client-persistence)

### 推荐的最小正常新增轮顺序（Moni 自定义决策）

1. 请求只表达本轮新增意图：稳定 `threadId`、本轮幂等请求标识（可与受校验的 `runId` 对应）、预期数据集/会话版本，以及一条 user 文字输入。客户端 message ID 仅作为显示关联提示；服务端分配 canonical user message ID。拒绝夹带 assistant/tool/system 历史、替换旧消息、任意 tools、context、模型地址或权限字段。AG-UI 原生载荷如何提取这条新增输入，在适配层明确约定。
2. 完成 Access/owner、会话归属、活动数据集与版本检查；同请求标识不同内容拒绝，相同内容重试回读已接纳结果。请求标识不得把其他会话的运行记录拿来复用。
3. 一个 D1 短事务内取得该会话回合执行权并追加 canonical user 消息，持久保存执行标识、消息映射和幂等收据。它是应用自己的追加命令，**不是**把 `[newUser]` 传给完整替换接口 `saveThread`。并发输家不落新消息、不调用模型；任何持久化失败也不调用模型。
4. 成功后才调用 `chat`，使用受信任 thread/run 标识、固定的服务端工具及该数据集的持久化适配器；传入 `messages: []`，让 `withPersistence` 读取刚写入的完整历史。本轮没有 SDK interrupt 时不转发任意客户端 `resume`。
5. 持续验证执行权；最终消息保存、业务草稿写入与回合终态只有当前持有者可以提交。直到流消费和终态保存完成后才释放回合，不能在构造/返回 Response 时立即解锁。

第 4 步的源码依据是 `withPersistence.onConfig` 从 MessageStore 读取 stored，再执行 `mergeStoredMessages(stored, [])`；后者返回 stored 副本。[middleware.ts:2288–2317](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/middleware.ts#L2288) 这与“先清空请求导致新增输入丢失”不同：**输入已经在第 3 步可靠落库**。不能省略第 3 步照搬空数组。

run 关联方面，SDK 会将本轮新增 assistant 标注 `metadata.tanstack.run.id`；它不自动建立“预存 user 消息属于哪个请求”的业务映射，所以该映射由第 3 步保存。相同 run ID 的存在本身也不禁止再次调用模型，应用回合 claim 仍须阻止重复执行。[middleware.ts:366–383](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/middleware.ts#L366)

S0 需证明：原生 hook/AG-UI 载荷与新增操作的衔接；服务端新分配 ID 与客户端临时气泡的对齐；刷新后无重复 user 消息；重试不再调用模型；预存失败无模型请求；新的 assistant 与正确 run 关联。reload、重新生成和 interrupt resume 不是普通新增轮，不默认开放；若开放需独立验证，不能靠 incoming 已有 ID 的默认截断规则承担权限决定。

## 3. D1 stores 与 testkit

- 官方 Cloudflare recipe 确实要求应用按请求的 D1 binding 构造 stores，不提供成品 D1 backend；其示例 schema 把完整会话放一个 JSON 单元格，是示例存法，不能覆盖 Moni 的 D1 行大小与长会话约束。[本地 recipe](../../.agents/skills/ai-persistence/build-cloudflare-adapter/SKILL.md)
- `withPersistence` 最低要求 messages；runs 用于生命周期，interrupts 依赖 runs，metadata 视功能选用。Moni 已确定用业务草稿按钮确认财务，不需要为了该按钮强行增加 SDK interrupt 引擎；需要运行状态时实现真实 RunStore。[types.ts:663–703](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/types.ts#L663)
- 技能还写着“四个 chat / 七个总 stores”，同提交源码已多出可选 `activities`：总计八种。首版不用 AG-UI activity 事件时可以省略，但 testkit 要声明省略。不能把 stores 键固定复制为过时列表。[types.ts:651–659](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/types.ts#L651)
- `saveThread` 完整替换、unknown thread 返回 `[]`、rich message 及 metadata 往返、run 创建 insert-if-absent、unknown run update no-op、interrupt 创建不复活已解决状态、列表顺序与复合键都要验证。`findActiveRun` 是 RunStore 必需方法，不能用恒定 null 伪装实现。
- 官方导出 `runPersistenceConformance`；同提交 suite 支持声明 `skip`、`skipMethods`、可选 checks。无 activities/生成能力的 chat adapter 显式省略 `activities`、`generationRuns`、`artifacts`、`blobs`；若不实现 interrupts/metadata 也逐项声明。锁不属于 suite。消息 metadata 与 run list 当前状态的检查默认不启用，使用相关能力时主动启用。[conformance.ts:1–26、67–79、119–150](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/testkit/conformance.ts#L1)
- SDK `onStart` 快照失败会被捕获并继续运行，所以不能代替前述“先可靠保存本轮 user 输入”的 Moni 保证。终态按先保存 transcript，再解决 resumes、再完成 run 的顺序执行；几个 store 调用不是自动跨表事务。[middleware.ts:2320–2332](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/middleware.ts#L2320)、[2495–2517](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/middleware.ts#L2495)

## 4. 锁：不要求 DO，也没有自动整轮锁

官方 `LockStore` 只是 `withLock(key, callback(signal))` 契约；`withLocks` 源码仅在 setup 提供 capability，不自动包住 chat、持久化或工具循环。`InMemoryLockStore` 仅对同进程有效。官方 Cloudflare recipe 的 DO lease 是一个示范后端，而非接口限定的唯一实现。[locks.ts:23–28、94–100](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/activities/chat/middleware/locks.ts#L23)、[官方 Locks 文档](https://tanstack.com/ai/latest/docs/advanced/locks)

Moni 可继续采用应用层 D1 回合 claim、有效期和递增 fencing token，而不先实现通用 LockStore，也不默认引入 DO。claim、续期、释放都要比对当前持有者；旧持有者失权时终止模型/工具，并由数据库拒绝旧 token 的持久化。续期失败不能继续写入。所有消息快照替换也必须经过同样检查；否则过期回合仍可覆盖新回合。

这是应用设计推论，尚未验证。只传 AbortSignal 不能收回已提交外部请求，租约过期也不能单凭 SDK run ID 保证供应商不会重复计费。若未来确有 middleware 消费 LocksCapability，再实现遵守同一语义的 D1 LockStore；没有该消费者时仅加入 `withLocks` 没有整轮互斥效果。

## 5. DeepSeek：接入成立，能力仍需验收

同提交适配器支持 `openaiCompatible` / `openaiCompatibleText`，默认 Chat Completions，并解析 DeepSeek 风格 `reasoning_content`。npm 元数据已有 compatible 子路径，故这条选择有发布及源码依据。[compatible factory](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-openai/src/compatible/index.ts#L44)、[reasoning adapter](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-openai/src/compatible/adapter.ts#L40)、[官网 Compatible Adapter](https://tanstack.com/ai/latest/docs/adapters/openai-compatible)

但声明模型名只建立 TypeScript 选择范围，裸字符串的乐观能力推断不是供应商能力探测。DeepSeek 目前文档的模型名称已经不同于部分 TanStack 示例，因此不将技能示例名称直接固定为默认值；实施时从 DeepSeek 官方可用模型中确认。

DeepSeek 官方 JSON Output 使用 `json_object`，要求提示 JSON，并注明可能出现空内容或截断；它不等于任意 JSON Schema 都获得服务端严格约束。严格工具 schema 另属 beta，需对应地址、strict 参数与支持的 schema 子集。不能由兼容接口推导出默认地址支持 SDK 所有结构化输出策略。[DeepSeek 入口](https://api-docs.deepseek.com/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)

Moni 优先以服务端 `toolDefinition` 的受校验输入完成准备草稿、汇率及查询，模型不得直接写正式账目。结构化结果经业务 schema 运行时校验通过后才成为可确认草稿。`outputSchema` 与工具混用、JSON fallback、推理字段保存及模型特有参数仍列 S0/S4 验收；没有真实调用证据时不承诺全部可用。

## 6. 长会话：不得裁掉权威历史再完整保存

同提交官方 compaction 文档明确区分 `messages`（完整 canonical transcript）与 `providerMessages`（临时模型输入）；`withCompaction` 只改后者，不因 middleware 顺序改变这个边界。[compaction.md:497–510](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/docs/advanced/compaction.md#L497)

因此“完整历史保留、模型只看受限上下文”有官方独立接口依据，但不能在 persistence 的 `messages` 上随意 slice，否则 onFinish 的完整替换可能删除旧历史。首版在安全裁剪接口完成 S0 验证前，可采用有界完整上下文：超过明确上限时不调用模型，提示开启新会话，D1 原历史仍可查看。不默认增加自动摘要、跨会话长期记忆或额外包；若采用 compaction，另核对其发布版本与实际组合测试。

## 7. 对现有方案的具体修订清单

以下按本轮复核开始时的章节标识定位；对应决定已同步到主文档与实现计划，运行证明仍留待 S0。

| 位置 | 应修订或补实的条目 |
| --- | --- |
| technical-design §8.1 | 记录真实已发布版本基线与 peer 兼容性；不把 skill frontmatter 当包版本，不默认装 MCP UI。 |
| technical-design §8.3 | 明确“接纳单条新 user → D1 原子 claim/可靠保存 → SDK messages 空数组读完整历史”的顺序，以及重试、reload/resume 的分别处理。 |
| technical-design §8.3 | 回合互斥为应用自定义 D1 协议；`withLocks` 不自动加锁，fencing 要覆盖 SDK stores 的每次写入。 |
| technical-design §5.1 / §8.3 | 实现确定的 store 能力层；activities 为可选，官方 testkit 按实际省略声明，不复制过时“四键”枚举。 |
| technical-design §8.2 / §12 | 区分 DeepSeek JSON、strict beta 和 SDK outputSchema；先对服务端工具及结果做运行时校验，模拟与真实验证分别报告。 |
| technical-design §8.3 | 独立 provider context 才能裁剪；未验证时超限提示新会话，不改写 canonical history。 |
| implementation-plan S0 | 新增协议伪造、同 ID 截断、预存失败、lease 失效后旧快照、testkit omissions、模型 schema 策略与上下文保全验证。 |
| implementation-plan S4 | 刷新/跨设备须验证活动 run 的处理：官方 hydrate 会返回 activeRun，客户端可能尝试 join；不承诺续流的首版需明确可解释的中断/忙碌行为，不能把 `findActiveRun` 写成 null stub 回避。 |

S0 尚未运行：这些结论来自技能、文档、源码和发布元数据。未核实安装产物、原生 hook 端到端消息 ID 对齐、D1 并发与 lease 续期、终态持久化错误如何反馈到 UI、无 durable stream 时 activeRun 行为、DeepSeek 实际 schema/工具能力及 Workers 兼容性。

本轮已下载官方技能、记录来源与许可，并将复核结论同步到技术方案和实现计划；未安装业务依赖、执行 Intent、运行构建、读取真实密钥、调用模型或部署。
