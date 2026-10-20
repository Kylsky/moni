# Moni 微信 ClawBot 入口可行性核查

日期：2026-10-18。状态：官方协议与仓库源码核查，未扫码、登录、收发消息或运行验证。

后续状态：使用者已确认“共用账本、微信专用会话、网页可查看历史”的设计，详见[微信入口与专用会话设计](../wechat-entry-design.md)。下文保留初次调研的候选方案；接收层实现、排期和确认方式仍待定，跳转网页确认不构成最终交互限制。

本笔记只研究用户确认的微信 ClawBot／“龙虾插件”入口，不扩展公众号、企业微信或元宝。Moni 目前的已定架构仍见[技术方案](../technical-design.md)：Worker + D1 + 每会话一个 DO + TanStack AI。本笔记提供候选方案，不将微信接入、文字确认入账或后台常驻自动加入首版范围。

## 结论

- 可以将 ClawBot 作为 Moni 的额外文字入口：腾讯官方仓库公开了扫码、接收和回复的 HTTPS JSON 协议，有不依赖完整 OpenClaw 的技术路径。是否可由当前微信账号完成授权、持续使用以及符合具体服务要求，尚未实测。[官方仓库](https://github.com/Tencent/openclaw-weixin)、[官方协议](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md)
- 官方 npm 包本身是 OpenClaw 插件，包含宿主 API 和 Node 文件系统依赖，不能据此承诺直接装进 Worker 就能运行。社区有独立 SDK，但本次查到的两个都需要兼容性和可靠性补齐。[官方包配置](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/package.json)、[官方 API 实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)
- 首个候选闭环：微信发文字 → Moni 生成草稿或查询结果 → 微信收到文字摘要与网页版链接 → 经 Access 登录后在网页确认入账。不自动授予“回复确认”写账权限，不自动加入语音、图片和主动提醒。
- Cloudflare 原生接入有可研究路径，不能立即断言必须另买 VPS。接收侧需要独立的账号级轮询协调器，不能直接让每个会话 DO 各自拉取同一账号消息；长轮询运行、恢复和费用仍需单独验证。

## 1 官方来源、版本与许可

核查时腾讯官方仓库 `Tencent/openclaw-weixin` 的 main 提交为 `874637a0dbc24050f72d1385add4fc6170a2d726`，README 链接官方 npm 包 `@tencent-weixin/openclaw-weixin`。官方 npm registry 的 latest 为 `2.4.10`，声明 Node `>=22.13.0`、OpenClaw peer `>=2026.5.12`；README 另外区分较宽的宿主运行时检查，不能把两者混为一个要求。[README](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/README.zh_CN.md)、[npm 元数据](https://registry.npmjs.org/@tencent-weixin%2fopenclaw-weixin/latest)

实际 LICENSE 是腾讯版权声明及 MIT 授权正文。GitHub `licenseInfo` 自动识别为 Other，不代表没有许可证；应以文件为准。MIT 许可约束代码复制和分发，不能据此推定线上服务永久开放、无配额或“零封号”。[LICENSE](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/LICENSE)

## 2 接收、回复与登录协议

以下均来自该提交的[官方协议文档](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md)，它描述插件与兼容后端的行为，不等同于已经完成 Moni 的真实接入验收。

| 项目 | 已证实的接口与含义 |
| --- | --- |
| 传输 | HTTPS JSON，默认 `https://ilinkai.weixin.qq.com`；媒体另用 CDN。 |
| 开始扫码 | `POST /ilink/bot/get_bot_qrcode?bot_type=3`，不是把普通微信密码交给 Moni。 |
| 扫码状态 | `GET /ilink/bot/get_qrcode_status`；还可能进入验证码、过期或服务端重定向状态。 |
| 授权结果 | 返回 `bot_token`、Bot 账号 ID、扫码用户 ID 和服务端 base URL。 |
| 接收 | `POST /ilink/bot/getupdates` 长轮询；请求传回上一响应的 `get_updates_buf` 游标。 |
| 等待时间 | 响应可给出 `longpolling_timeout_ms`，官方客户端默认 35 秒；不是微信 webhook 推送。 |
| 回复 | `POST /ilink/bot/sendmessage`；文本类型在 `item_list` 中，带目标用户和客户端消息 ID。 |
| 鉴权 | Bot API 使用 Bearer token，并携带协议规定的应用与版本头。 |

本次未在官方公布的接口清单中找到可直接替代长轮询的 webhook 订阅入口，不能据此保证平台未来或其他产品没有 webhook。

回复应回传对应入站消息的 `context_token`。官方明确说明：客户端缺令牌时发出请求，并不证明服务端一定接受。因此首版不能以此承诺任意主动推送。已查资料没有规定固定的 context token 有效期，也没有足够依据声称“24 小时窗口”。扫码凭据过期或失效需要单独恢复；官方客户端将 `-14` 当作会话失效并暂停调用，这个退避策略不是永久免重新登录的保证。[协议回复说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md#sendmessage)、[失效处理源码](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/session-guard.ts)

官方 API 调用主体使用 `fetch`，协议层可以独立实现；但现成文件顶层读取本地 package.json 和 OpenClaw 配置，账号实现使用本地 JSON 凭据文件与 `openclaw/plugin-sdk`。这是“协议可拆出”和“现有 npm 包可直接运行”的区别。[API 源码](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)、[账号存储源码](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/accounts.ts)

## 3 两个独立社区 SDK

下表为社区作者仓库的代码事实，均不是腾讯官方 SDK，也没有在本项目安装。社区 main 是可变化的，下面的代码核查只代表本次读取到的状态。

| 候选 | 可复用之处 | 对 Moni 的实际限制 |
| --- | --- | --- |
| [photon-hq/wechat-ilink-client](https://github.com/photon-hq/wechat-ilink-client) | 独立 TypeScript 客户端；用户可注入 token 和游标持久化回调，无需 OpenClaw 宿主。 | 包声明 Node >=20，二维码终端包是可选依赖；核心引用 `node:events`、`node:crypto` 与 Buffer，媒体功能读取本地文件。不能概括为原生 Worker SDK。 |
| [NebulaMao/wechat-iLink-sdk-typescript](https://github.com/NebulaMao/wechat-iLink-sdk-typescript) | 分离 API、认证和消息收发，适合参考或另设 Node 桥接。 | 包声明 Node >=18，提供 `FileTokenStore`；接收循环的游标默认在内存，定时器驱动后续请求，不能直接获得 DO 重启恢复。 |

photon 的“纯内存”指它不自动把账号状态写入磁盘；媒体接口仍有 `fs.readFile`。包配置没有普通 dependencies，但存在 optionalDependencies，因此“零依赖”也要说明统计口径。[包配置](https://github.com/photon-hq/wechat-ilink-client/blob/main/package.json)、[客户端](https://github.com/photon-hq/wechat-ilink-client/blob/main/src/client.ts)、[媒体文件读取](https://github.com/photon-hq/wechat-ilink-client/blob/main/src/media/upload.ts)

本次还发现 photon 有三处不能直接照搬的行为：获取二维码仍使用 GET，与当前官方 POST 文档有差异；发送接口只核对 HTTP 状态，没有解析响应 `ret`；接收循环先保存新游标再派发消息，若随后业务接纳失败，存在跳过未可靠接纳消息的窗口。前两项由当前官方协议和该库 API 源码比较得出，第三项是由执行顺序推导的故障风险，均未做真实服务复现。[API 源码](https://github.com/photon-hq/wechat-ilink-client/blob/main/src/api/client.ts)、[轮询顺序](https://github.com/photon-hq/wechat-ilink-client/blob/main/src/monitor.ts)

NebulaMao 的仓库 package.json 标注版本 `1.0.4` 和 MIT，但本次未验证其 npm 发布包与仓库完全一致；两个社区仓库的树中均未找到单独 LICENSE 文件，若要复制大段代码，需先核对发布物与许可声明的完整性。[包配置](https://github.com/NebulaMao/wechat-iLink-sdk-typescript/blob/main/package.json)、[凭据文件存储](https://github.com/NebulaMao/wechat-iLink-sdk-typescript/blob/main/src/auth/token-store.ts)、[接收循环](https://github.com/NebulaMao/wechat-iLink-sdk-typescript/blob/main/src/messaging/receiver.ts)

选择建议：优先以当前腾讯官方协议为依据，仅为文字接入研究最小适配；photon 可作为独立客户端参考，不应凭 README 宣传直接选作生产依赖。也不为收发文字引入整套 OpenClaw、媒体管线或另一套 Agent 执行框架。

## 4 Cloudflare 适配判断

### 一个 Bot 的接收协调与一个会话的 AI 执行分开

候选结构是：微信后端 → 一个 Bot 账号对应一个接收协调器 → 可靠接纳与绑定校验 → 现有会话 DO → TanStack AI／共享账目模块 → 回复发送。接收协调器负责账号级游标、轮询、退避和连接状态；现有会话 DO 仍负责单个 Moni 会话的 AI 回合。

若每个会话 DO 都轮询同一 Bot token，就会让不同会话各自维护同一个消息源的游标，且无法建立清晰的全账号接纳顺序。以上是架构推论，不是官方强制的数据模型。可以研究额外的 Bot 接收 DO，也可以另设常驻 Node 桥接；当前未确定新增 DO 类、绑定与部署配置。

### DO 可以发长轮询，但需要有界执行与恢复

35 秒网络等待不等于 35 秒 CPU 使用。Cloudflare 区分 CPU 时间和墙钟时间，DO alarm handler 的墙钟上限为 15 分钟，普通 DO RPC/HTTP 则依赖调用连接与运行条件。不能用默认 30 秒 CPU 限制直接判定长轮询不可能，也不能把 alarm 中无限循环当作永久进程。[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)

待完成的 outbound fetch 会阻止休眠并产生 duration 费用，DO 仍可能因部署和运行时操作重启；不能依赖内存中的游标、定时器或退出钩子保证不丢进度。[DO 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

因此可研究有界轮询批次、持久游标、alarm 续调与退避：每批先将入站消息可靠写入接纳记录，再推进游标；派发和回复由幂等收据及可重试状态驱动。alarm 是至少一次执行并有失败重试，所有接纳与发送核对必须允许重复。此方案为应用设计推论，微信游标的重复读取和保留语义、Cloudflare 连续运行与费用仍未实测。[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

若 Cloudflare 原生方案在持续收取、延迟或费用上不合适，再选择小型 Node 桥接；它会增加部署者必须维护的运行环境，不能仍宣称只有一个 Cloudflare 按钮即可完成全渠道部署。

## 5 Moni 权限、凭据与财务边界

Access 认证的是网页请求中的应用身份，微信消息提供的是 Bot／发送者通道身份，两者不能互相替代。当前[技术方案](../technical-design.md)明确拒绝将 service token 当本人登录；新增渠道必须单独定义可信来源与绑定过程，不能为接微信放宽全站身份检查。[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

若后续批准接入，建议先满足以下边界：

- 在已通过 Access 的设置页建立本人微信与当前部署的绑定，校验 Bot 账号及发送者标识；不接受“第一个发消息的人自动成为 owner”，不把消息正文中的邮箱或 owner 值当身份。
- 首个候选闭环仅接收文字，生成草稿或调用已有只读查询。草稿带可打开网页版的引用，网页经 Access 后显示内容和确认按钮；链接本身不携带 token、金额明细或可重放的入账执行权。
- 微信入口映射到明确的 Moni 会话，不能静默借用浏览器当前会话；新建、切换与重置规则还需产品决定。微信重复投递、同账号重复轮询不能重复调用模型或重复建草稿。
- 机器人 token、context token 和二维码授权状态按敏感凭据保护，不能进入前端构建、日志、公开仓库或业务 JSON 备份。固定部署凭据可使用 Worker Secret；若实现网页动态登录，必须另行决定服务端凭据保存与轮换机制，不能默认明文写入 D1。[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- 若采用外部 Node 桥接，独立设置受限机器身份与请求防重；仅暴露必要的通道接纳能力，不让桥接持有网页 owner 身份或任意数据库权限。若采用内部 Bot DO，通过 binding 路由，不另外开放可伪造的匿名 webhook。

这些是候选接入的正确性边界，未表示已经修改当前需求或执行任何外部绑定。

## 6 接入前必须验证

1. 当前微信账号能否进入 ClawBot、扫码授权、完成需要的验证码及重登；token 失效的真实行为。
2. 当前官方请求头与 POST 登录方式、文本收发、回复 context token、HTTP 成功但业务失败的判断。
3. 同 Bot 单接收者、游标推进和可靠接纳的顺序；进程在入库前后故障时的漏收、重复与恢复。
4. Bot 接收协调器与会话 DO 分工，网页／微信同时提问时的忙碌与重试行为；不同会话不会串上下文。
5. Cloudflare 部署更新、alarm 重试、长轮询断开与退避；连续运行的实际延迟、网络可达性和费用。
6. 只绑定本人、撤销绑定立即失效、凭据无日志和导出泄漏；网页版确认保持 Access 检查和原有入账幂等。
7. 微信查询结果按程序统计渲染，草稿保持待确认；收到“确认”文字不自动绕过现有财务确认动作。

本次只新增此研究笔记。未安装 SDK、使用真实凭据、扫码授权、发送微信、修改业务代码、改需求／技术方案／阶段计划或部署；因此不能宣称接入已跑通、长期在线或无封禁风险。
