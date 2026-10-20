# TanStack AI 长会话与上下文压缩调研

日期：2026-10-19。范围：核对官方能力、已发布包与 Moni 现状；本轮不安装依赖、不实现滑动窗口或摘要，不读取私密配置或个人账目。

后续使用者已授权并完成接入，当前实现与验证见[长会话验证记录](../verification/chat-compaction.md)。下文中的“当前／待实现”指本次调研时的版本快照，不能代替后续实现状态。

## 结论

TanStack 已提供官方 `@tanstack/ai-compaction`。`withCompaction` 在每次模型调用前检查预算，可自动丢弃最旧上下文，或用摘要替换旧上下文；原会话和完整持久化历史可以保留。因此，**模型上下文超限不必要求用户新建微信会话**。它需要应用接入中间件，单独调用 `chat()` 不会自动开启这项能力。[官方说明](https://tanstack.com/ai/latest/docs/advanced/compaction)、[已发布实现](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L507)

但官网 `latest` 已包含尚未进入当前 npm 包的功能，实施必须以发布包为准，不能照抄全部最新示例。

## 版本核对与证据边界

| 项目 | 本次确认 |
| --- | --- |
| Moni 安装版本 | `@tanstack/ai 0.69.0`、`@tanstack/ai-persistence 0.9.0`；来自本机 `node_modules` 的包元数据。 |
| 官方 compaction 发布版 | npm `latest` 为 `0.2.0`，2026-10-13 发布；peer 要求 `@tanstack/ai ^0.69.0`，与本机 core 匹配。Moni 尚未安装。 |
| 发布源码 | 官方 tag `@tanstack/ai-compaction@0.2.0` 指向提交 `293aea91a187ccce331c99c3b936d8cf4d4a72e2`。已下载 npm tarball 到临时目录，逐字节确认其 `src/index.ts` 与该提交相同。 |
| 官方主分支 | 本次 GitHub API 返回 `85c2956c68f3226ef409b3a4e54d5be82198931e`，提交时间 2026-10-15；官网最新功能与该分支一起核对。 |

发布事实来自官方维护者的 [npm 包元数据](https://registry.npmjs.org/@tanstack%2fai-compaction/0.2.0)、[官方 tag](https://github.com/TanStack/ai/tree/%40tanstack/ai-compaction%400.2.0)、[发布记录](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/CHANGELOG.md#L3)、[本次主分支提交](https://github.com/TanStack/ai/commit/85c2956c68f3226ef409b3a4e54d5be82198931e)。peer 匹配只证明声明兼容，本轮没有验证 Moni 的 D1/DO 组合或真实模型。

## 当前发布版确实可用的 API

以下均以 `0.2.0` 的实际源码为准。

| API | 行为与限制 |
| --- | --- |
| `withCompaction({ maxTokens, strategy, estimateTokens, strategyKey, onCompact, native })` | 必填预算 `maxTokens`；每次模型调用检查，默认策略为 `evictOldest()`。`init` 阶段跳过，模型调用阶段重新计算。 |
| `evictOldest({ keepRecentTokens, marker })` | 接近滑动窗口：保留最近消息，旧消息换成标记；不额外调用模型。默认保留预算的一半。 |
| `summarizeOldest({ summarize, keepRecentTokens, summaryRole })` | 旧消息换成一条不可信会话摘要，近处原文保留。`summarize` 必须由应用提供，签名为 `async (messages) => string`，不是把 `summarize()` 的完整结果直接返回。空摘要会抛错，避免无声丢失旧内容。 |
| `clearToolResults({ keepRecentToolResults, stub })` | 保留调用关系，只把旧工具结果正文换成短占位符；默认完整保留最近 3 个工具结果，不额外调用模型。 |
| `composeStrategies(...strategies)` | 按顺序尝试，估算回到预算以内就停止，可组合便宜清理与更强压缩。 |

来源：[发布版类型与滑动窗口](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L290)、[摘要策略](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L390)、[工具结果与策略组合](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L427)。

默认 token 估算是字符数除以 4，同时计入工具调用 JSON；对中文和结构化账目只能作为粗估。系统提示由 core 独立传递，不属于被裁剪的消息数组，预算仍需为提示、工具定义和模型输出留空间。[发布版估算器](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L253)、[core 模型输入](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/activities/chat/index.ts#L1860)

`summarize()` 是通用文本摘要活动：接收 `adapter` 和 `text`，返回含 `summary` 的结果；它本身不选择历史、不触发阈值、不保存会话检查点。自动会话压缩来自 `withCompaction` 与 `summarizeOldest` 的组合。[摘要 API](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/activities/summarize/index.ts#L55)

## 官网已有、但 npm 0.2.0 尚不可用的功能

本次逐项比对发现：`background`、`countTokens: 'usage'`、`auto`、`contextWindow`、`durable`、`continueOnError`、`compactNext`、`conversationSummarizer`、`summarizeOldest({ cut: 'turn' })`、摘要返回 `{ summary, usage }`、遇到上下文溢出后自动压缩并重试，均出现在官网/主分支，但不在下载的 `0.2.0` 公共类型或实现中。**不可把这些当成当前安装后立即可用的能力。**[主分支新增类型与实现](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-compaction/src/index.ts)、[发布版完整源码](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts)

`native` 已发布，但需要适配器真正提供 `compact()`。OpenAI 兼容聊天地址并不能证明某个代理或模型支持服务端 compaction；Moni 当前模型不应默认采用这一通道。[已发布 native 分支](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L523)

## 与持久化、工具调用的边界

- `config.messages` / `ctx.messages` 是完整权威历史；`config.providerMessages` 是仅本次模型使用的投影。compaction 返回后者，`withPersistence` 保存前者，**不会因为压缩模型输入而删除旧消息**。core 每次模型调用重建配置时又从完整历史开始，因此必须每次投影，不能只在请求开始时裁一次。[core 类型](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/activities/chat/middleware/types.ts#L337)、[core 配置重建](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai/src/activities/chat/index.ts#L5024)、[持久化保存](https://github.com/TanStack/ai/blob/85c2956c68f3226ef409b3a4e54d5be82198931e/packages/ai-persistence/src/middleware.ts#L2308)
- 有 metadata store 时，发布版会保存压缩结果、来源前缀 hash 与策略标识；下次校验一致后复用并追加新消息。改变摘要提示或估算规则时，应改变 `strategyKey`；不能复用语义已失效的检查点。[发布版检查点校验和保存](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L569)
- 内建裁剪会调整边界，避免留下没有对应 assistant 调用的开头 tool result；尾部正在完成的工具组也有保留逻辑。该保护不等于“保留当前完整用户回合”，发布版没有 `cut: 'turn'`，Moni 必须另行验证本轮 user、调用与结果整体仍可理解。[发布版切分逻辑](https://github.com/TanStack/ai/blob/293aea91a187ccce331c99c3b936d8cf4d4a72e2/packages/ai-compaction/src/index.ts#L320)
- 摘要属于模型上下文，不是账本事实或入账授权。金额、币种、草稿版本、已展示状态和用户确认时序仍由 D1/DO 判断，不允许摘要中的“已确认”替代实际授权。此项是 Moni 的业务约束，不是 SDK 自动提供的保证。

## Moni 的最小可靠接入建议（待实现）

建议保持同一微信会话，以官方 `withCompaction` + `summarizeOldest` 为目标：旧对话保存短摘要，最近完整回合保留原文。摘要聚焦用户当前意图、最近查账的时间范围/类别/标签/备注筛选和关键决定；明确已知与未知，避免丢失“那上个月呢”所需指代。无需新增跨会话记忆系统，也不必先依赖尚未发布的后台摘要功能。

现有 `src/ledger/chat-tools.ts` 的 `get_ledger_context` 已返回当前会话 `ready` / `needs_details` 草稿、ID、版本、逐笔金额和备注，以及 `previousQuery`；`src/ledger/chat-query.ts` 的 `previousLedgerQuery` 从完整 D1 历史取得最后可信查询，`runLedgerQuery` 再查正式账目。应复用这些入口恢复财务状态和连续查账条件。摘要只作为不可信参考，不能覆盖原始历史、实时工具结果或确认状态。

具体实现需要一起完成以下边界，不能仅在数组里加一行中间件：

1. 将当前 `40 条 / 32 KiB` 的模型上下文硬拒绝改为压缩后的预算检查。它们来自 Moni 自己的 `src/lib/limits.ts` 和 `src/chat-do.ts`，不是模型厂商强制的会话条数。完整历史的存储上限应单独管理。
2. 保留当前完整回合与工具配对；超大单条输入或当前工具组本身超过预算时清楚报错，不盲删其一部分。重建草稿/确认状态应读取服务端数据，统计金额继续从受保护查询工具获得。
3. 复用现有 D1 metadata store，使用数据集隔离的检查点和版本化 `strategyKey`；完整 `messages` 持续保存，UI 历史仍能回看。不要在 `MessageStore.saveThread` 之前 `slice` 权威数组。
4. 摘要调用设超时并使用同一私密服务配置；摘要失败、为空或过长时保持原历史及原检查点。发布版默认失败即终止；若要求不中断，可在业务层提供明确的工具安全窗口回退，不能把无效摘要写进检查点，也不能静默忽略用户本次请求。
5. 首先做可控模型 + 本地真实 D1/DO 验收：持续超过旧的 40 条限制、连续指代查账、多工具配对、待确认草稿不丢、压缩重试不重复入账、DO 重启复用、摘要失败恢复、检查点失效。之后才用合成账目做真实模型联调。

另一个独立边界：当前 `threadMessages: 1000` / `threadBytes: 1 MiB` 仍限制完整历史写入，compaction 只减模型输入，**不会解决存储容量上限**。若要求一个微信会话长期持续使用，还需调整持久化读写为可分页/增量处理或明确归档策略；不能声称接入 compaction 后会话就能无限增长。以上均为实现建议，本轮尚未执行。

## 本次完成与未验证

已完成官方网页、主分支、发布 tag、npm 包元数据及 tarball 源码交叉核对；已检查本地 core/persistence API 与 Moni 的上下文/存储限制、metadata 接口。

尚未安装 compaction、修改生产代码或需求范围，也未进行 SDK 组合运行试验、本地 D1/DO 验收或真实模型压缩联调。本文不能作为功能已接入或验收通过的证据。
