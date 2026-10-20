# Moni v0.1 平台可行性核查

日期：2026-10-18。状态：官方文档核查完成，未进行运行验证。

后续已先下载官网提供的 skills，再补做[官方 skill 与源码复核](2026-10-18-tanstack-official-skills.md)。SDK 版本、输入消息合并与锁语义以该复核及实施时锁定版本的源码为准。

本笔记对齐 `PRODUCT.md`、`GLOSSARY.md`、ADR-0001（退款按发生日）与 ADR-0002（确认时固定折算金额）。它为技术方案提供依据，不改变首版需求，也不表示安装、编码、部署或付费调用已获授权。

## 结论

- 单 Worker + D1 + Access 与现有需求相容；并发退款、幂等入账和整本替换有基于数据库原子操作的可行路径，没有文档依据要求为这些功能默认增加 Durable Objects 或 Queues。
- TanStack AI 接 DeepSeek、React 会话交互和服务端持久化均有官方文档；D1 接入仍需应用实现存储契约，不能当作开箱即用的已验证成品适配器。
- 会话存储、等待确认的业务草稿、正在生成的输出流是不同状态。只保存消息不能保证审批恢复，更不能保证 Worker 中断后自动继续同一次模型请求。
- 恢复超过单次数据库调用能力的账本时，可先分批装载非活动数据集，再原子切换活动指针；这属于应用设计推论，不是 D1 提供的 JSON 整本恢复功能。
- 部署按钮可以自动创建 D1 并执行配置好的迁移；Access 本人策略和部署端 owner 身份不能假定随按钮自动完成。首次配置未完成时必须拒绝账本及会话访问。

## 1. TanStack AI

### 已证实的文档事实

1. **DeepSeek 接入**：`@tanstack/ai-openai/compatible` 提供通用 OpenAI-compatible 适配器，官方直接给出 DeepSeek 示例，接收 API 地址、Key 和模型列表，默认使用 Chat Completions。模型能力须按实际服务声明；兼容接口不保证模型支持每种工具、图片或结构化输出能力，示例模型名不应作为当前模型清单。来源：[OpenAI-Compatible Adapter](https://tanstack.com/ai/latest/docs/adapters/openai-compatible)。
2. **React 交互**：`@tanstack/ai-react` 的 `useChat` 管理消息、发送、加载及错误状态，并提供工具结果、批准响应等交互入口；UI 布局与文案仍由应用提供。来源：[React API](https://tanstack.com/ai/latest/docs/api/ai-react)、[React Chat UI](https://tanstack.com/ai/latest/docs/ui/react)。
3. **D1 是应用存储适配工作**：官方将适配器定义为一组 store 函数，D1 可使用现有数据库及应用自己的 schema；官方 D1 recipe 的职责是生成应用内适配代码。本次没有找到可据以承诺“安装后直接绑定任意 D1 即可使用”的成品契约。来源：[Build Your Own Adapter](https://tanstack.com/ai/latest/docs/persistence/build-your-own-adapter)、[官方 Cloudflare adapter recipe](https://tanstack.com/intent/registry/%2540tanstack%252Fai-persistence/ai-persistence%2Fbuild-cloudflare-adapter)。
4. **存储语义**：`messages` 是持久化最低要求；`saveThread` 收到完整合并后的消息列表，必须按完整替换语义保存，不能无条件追加。`runs.createOrResume` 与 interrupt 创建须保留 insert-if-absent/幂等语义。要恢复待审批状态需 `interrupts`，而它依赖 `runs`。可选的 interrupt `commitBatch` 须将全部条目原子提交；逐个 resolve/cancel 的兼容回退并非原子。来源：[Store Reference](https://tanstack.com/ai/latest/docs/persistence/store-reference)。
5. **保存时机并非处处强保证**：开始运行时和可选的流中快照是 best-effort；完成与 interrupt 边界的持久化失败会传播。流中快照默认关闭，不能把“开了 persistence”写成每个中间 token 已落库。来源：[Chat Persistence](https://tanstack.com/ai/latest/docs/persistence/chat-persistence)。
6. **权限仍归应用**：稳定的 `threadId` 标识会话，`runId` 标识一次执行；读取、保存和恢复会话前都要验证权限，不能把客户端提供的 thread ID 当作所有权。来源：[Persistence Internals](https://tanstack.com/ai/latest/docs/persistence/internals)。
7. **durable stream 独立**：持久化保存会话状态；durable stream 重播一次执行的输出流。`memoryStream` 只适合同一存活进程，跨 Worker 或进程终止不保留其日志。生产恢复同一输出流需要额外持久化传输后端；进程死亡还需要 lease/reaper 机制，不能只靠 `finally`。来源：[Resumable Streams](https://tanstack.com/ai/latest/docs/resumable-streams/overview)、[Advanced](https://tanstack.com/ai/latest/docs/resumable-streams/advanced)。

### 对 Moni 的建议与推论

- D1 中分别保存正式账目、可编辑草稿以及会话状态。账目是否已确认，以业务写入结果为准；SDK 的“工具已批准”“run 已完成”不等同于账目恰好写入一次。
- 业务确认可由持久化草稿和普通确认接口承担；只有采用 SDK 的挂起工具批准流程时，才需要对应的 `runs`、`interrupts` 和恢复协议。不能只存消息文本后承诺恢复审批。
- 同一会话需有数据库可见的并发控制，避免两个设备同时生成后以完整替换方式相互覆盖。可以研究 D1 内的条件 claim/状态版本；不能依赖单个 Worker 进程里的锁。
- 首版可先满足“刷新、换设备后恢复已保存会话和待确认草稿”。对中断中的生成明确记录失败或中止，允许使用者显式重试；不默认承诺无缝继续原请求，也不为此默认引入 DO/Queues。若后续要求同一流跨进程续传，需要独立评估 durable stream 后端。
- SDK 存储契约不要求整段会话塞进一个 JSON 单元格；D1 单行大小限制和完整替换的原子性必须同时考虑。实施时按所选版本的官方存储 conformance suite 验证适配器，不能用类型检查替代。

## 2. D1 写入、退款与整本恢复

### 已证实的文档事实

- **短事务**：`batch` 接收预备语句，顺序、非并发执行；某条语句失败会终止或回滚整批。D1 的绑定 API 不提供可跨 HTTP 请求持有的应用长事务契约。来源：[D1 Database / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。
- **并发模型**：单个 D1 数据库单线程处理查询，但这不代表分开的“先读取、后写入”调用是一个原子操作。来源：[D1 Limits / concurrency](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)。
- **约束**：D1 支持唯一索引；默认强制外键。`defer_foreign_keys` 仅将检查推迟到当前事务末尾，不能永久关闭外键。来源：[Use Indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)、[Foreign Keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)。
- **CHECK 与触发器**：D1 使用 SQLite 查询引擎，文档列出 CHECK 和递归触发器开关；SQLite 的 `RAISE(ABORT, ...)` 可使触发器触发的写入报约束错误。具体业务触发器尚未在 D1 运行；SQLite 语义依据不等于本项目迁移已验证。来源：[D1 SQL Statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html#the_raise_function)。
- **返回结果**：写入结果包含 `meta.changes`；条件更新影响零行不等同于 SQL 错误，应用必须判定是否成功匹配目标状态。来源：[D1 Return Objects](https://developers.cloudflare.com/d1/worker-api/return-object/)。

当前需要落实到设计中的限制如下；这些不是对 Moni 已测得的上限：

| 官方限制 | 对方案的影响 |
| --- | --- |
| 每条 SQL 最多 100 个绑定参数、SQL 长度 100,000 bytes | 插入批次按参数数与语句长度拆分，不能按固定账目条数盲目拼接。 |
| 单个字符串、BLOB 或整行最大 2,000,000 bytes | 不把整本 JSON 或无限增长的完整会话作为单行保存。 |
| 最大 SQL 查询时长 30 秒；官方注明整个 batch 也受时限影响 | 单 batch 不能承担任意大的整本恢复。 |
| 每次 Worker 调用 D1 查询预算 Free 50 / Paid 1000 | 导入和校验需要分块，并核对所选计划和实际调用方式；不能把 batch 当作无限查询额度。 |
| `d1 execute` 文件导入上限 5 GB | 这是管理工具 SQL 导入能力，不是网页 JSON 上传、Worker 内存或应用恢复的同等承诺。 |

来源：[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)。

官方管理工具导入使用 SQL；SQLite dump 要移除显式 BEGIN/COMMIT，并按表依赖顺序导入。超长 INSERT 需拆小。不能将 D1 SQL 导入当作不可信 JSON 的直接执行路径。来源：[Import and Export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

### 并发退款和防重：方案推论

下述方案由短事务、约束和 SQLite 触发器能力推导，尚未实施或证明：

1. 同一次保存携带稳定幂等键，数据库使用唯一约束；幂等键与写入内容摘要关联，同键不同内容拒绝。不能用“同金额、同日期”去重，因为两笔真实消费可以相同。
2. 关联表、幂等结果和账目写入放在同一短事务。冲突应回读已经提交的业务结果；不能以 `INSERT OR IGNORE` 静默跳过主记录后，仍继续写入子记录。
3. 退款原币累计上限放在数据库写入路径内检查，例如触发器在新增、修改、恢复退款时检查累计额；原支出金额/币种变更及删除也必须守住约束。聚合跨行约束不能仅靠逐行 CHECK 完成。
4. 违反规则时产生数据库错误，使整批回滚；不能先 SELECT 在 JavaScript 中判断，再单独 INSERT，也不能把“条件 UPDATE 零行”自动当作会回滚的错误。
5. 默认退款的主币种舍入尾差也在同一次原子写入内，依据已经确认的原折算金额处理，保持 ADR-0001、ADR-0002 口径；外部汇率和 AI 调用都在数据库事务外完成。

这条路径不要求增加 DO/Queues，但必须覆盖新增、编辑、回收站恢复和并发请求，才能声称阻止超额退款。

### 超过单 batch 的 JSON 恢复：方案推论

可以使用同一 D1 内的非活动 `dataset_id` 分批装载，最后切换 `active_dataset_id`，避免先清空当前账本。其安全性来自应用协议：

1. 预览与正式提交绑定同一份已校验内容；新数据集写入期间不对正常页面可见。检查版本、范围、ID 唯一性、关联关系、金额、币种、退款上限、会话及换算依据，不执行备份内 SQL。
2. 账本设置、账目、类目、标签、会话和草稿等可恢复内容都必须属于相同数据集；部署端 owner、Access 参数和 Secrets 独立保存，不从 JSON 恢复。
3. 数据集内部以包含 `dataset_id` 的关联键避免跨集引用。分批上传的重试须幂等；校验完成后封存，激活前不得继续写入。
4. 确认整本替换前，必须完成可恢复的当前账本备份。备份对应的旧活动数据集和业务 revision 作为切换前提；所有会改变备份内容的写入，包括会话和设置更新，都要纳入同一版本边界。
5. 最终用一个条件更新或短 batch 验证“旧活动数据集、预期 revision、新集校验状态”后切换指针。比较失败不切换，提示重新备份/确认。若 batch 内还有其他副作用，必须让前提失败变成整批错误，不能只检查 batch 完成后的零行结果。
6. 每个正常请求固定其数据集；所有写入在数据库操作内核验活动代次，阻止切换前开始的旧请求在切换后继续提交。统计、查账、导出和 AI 存储适配器也必须遵守这个范围。
7. 切换前失败保留旧集；切换后旧请求仍可能读取旧集，因此不能立即删除旧集。旧数据清理与遗留上传清理需要独立、可重试的有界步骤，不能影响新集可用性。

这种方式能用短事务完成“可见账本的原子切换”，但不意味着整个上传过程是一个跨请求事务，也不意味着无限大小备份可恢复。上传、单行消息大小、暂存空间、切换时并发 AI 写入与旧集回收仍需明确边界并测试。

## 3. Access、唯一 owner 与部署按钮

### 已证实的文档事实

- **Worker 级保护**：Access 可保护一个 Worker 的 production 与 preview 全流量；API destination 类型为 `worker`，`preview_worker` 仅保护预览。Worker 级保护不受访问 hostname 影响；hostname/path 级应用只保护所配置 URL。前提是账号启用 Zero Trust，且操作者有 Workers 与 Access 管理权限。来源：[Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。
- **服务端验 JWT**：官方要求 Worker 验证 `Cf-Access-Jwt-Assertion`，不能只检查头是否存在。示例用团队 JWKS 验签并核对 issuer、application audience。来源：[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
- **身份字段限制**：`exp` 是过期时间，`nbf` 是最早可用时间，`sub` 是该账号内用户 ID；删除并重新加入 Zero Trust、或换组织，会改变 `sub`。Service token 的 `sub` 可以为空，因此不能将“验签通过”直接解释为本人已登录。来源：[Access Application Token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)。
- **部署按钮**：可克隆公开仓库、让部署者调整名称、自动创建并绑定 D1 等资源；Wrangler 资源占位信息需符合按钮要求。迁移可放进 deploy script，并按 binding 名执行，避免部署者重命名数据库后失效。Secrets 可通过不含真实值的示例文件提示部署者配置。官方自动资源清单未承诺替部署者创建 Zero Trust 和“仅本人”的 Access 策略。来源：[Deploy Buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。
- **Secrets**：Worker Secrets 是服务端敏感绑定，不能写入普通配置变量或版本控制；本地 `.dev.vars`/`.env` 真实文件应忽略。来源：[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
- **Preview 数据隔离**：保护访问与隔离数据库是不同事情。Preview 若绑定同一 D1，仍会操作同一资源；需另绑数据库才能隔离。新 Worker Previews 还需匹配其最低 Wrangler 版本，不能将最新文档配置直接套入未知安装版本。来源：[Previews Resources and Isolation](https://developers.cloudflare.com/workers/previews/resources/)、[Previews Get Started](https://developers.cloudflare.com/workers/previews/get-started/)。

### 对 Moni 的建议与推论

- 首版使用 Worker 级 All traffic，外层 Access 仅放行本人；应用内仍校验签名、允许的算法、`iss`、`aud`、`exp`、适用的 `nbf`、应用 token 类型及非空 `sub`，再比对部署端唯一 owner。
- owner 绑定采用受信任部署配置，不能由匿名访问者“首次打开自动认领”，不能从上传备份覆盖；`iss` 与 `sub` 共同识别身份。重建 Access 应用或移除/重加用户后，允许部署者经控制台重新配置 audience/owner，而不清空账本。
- 缺少 Access 配置、owner 或有效 JWT 时，所有账本/会话/导出/恢复/AI 数据接口默认拒绝；页面只能显示无敏感内容的配置指引。公开引导页面不提供修改 owner 或写入 Secrets 的匿名接口。
- AI Key 使用 Worker Secret，网页只反馈是否配置；不将其设为手动记账必须的运行条件。API 地址与模型名是部署端配置，模型能力在实际所选版本和 DeepSeek 验收中确认。
- 部署成功、D1 建库、迁移成功、Access 配置、本人身份校验与预览覆盖需分别验证。不能把“按钮完成”写成“私人账本已安全可用”。

## 4. 后续实施必须证明的边界

这些是技术验证清单，未执行，不新增产品功能：

- 所选 TanStack AI 版本与 Workers 运行时兼容；D1 stores 通过对应 conformance 检查，完整覆盖替换、顺序、重试、失败和审批原子提交语义。
- DeepSeek 结构化输出和受控查询工具的实际行为；不自动承诺其他兼容供应商或未声明的模型能力。
- 本地 D1 与真实 D1 上触发器、唯一约束、batch 回滚、超额退款竞态及原消费编辑/退款恢复分支；不能用内存锁或串行单测代替并发证明。
- 恢复跨多批次中断、重试、校验失败、CAS 冲突、激活前后崩溃、切换时账目/会话并发更新、旧请求写入与临时空间耗尽；失败后当前账本仍完整可用。
- 缺失、伪造、过期、错误 issuer/audience、空 subject、非 owner 的 JWT；production、workers.dev、自定义域与 preview 入口均无绕过。
- 全新 Cloudflare 账号的按钮流程：D1 自动创建与迁移、Secrets 配置、Zero Trust/Access 手动步骤、未配置时默认拒绝访问。尚未登录账号或实际部署，不能证明 UI 流程已跑通。

本次仅读取官方资料与项目定稿需求，并新增此研究笔记；未安装依赖、运行构建、读取真实密钥、部署、访问账本数据或付费调用。
