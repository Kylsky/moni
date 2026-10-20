# Frankfurter / ECB 历史报价服务合同

核实日期：2026-10-18。只读取官方文档、官方仓库及匿名公共 API；请求没有账目、备注、模型配置或凭据。官方仓库快照固定为 [`f3529f1eb41a2fd952e82243517e34a79a42d044`](https://github.com/lineofflight/frankfurter/tree/f3529f1eb41a2fd952e82243517e34a79a42d044)。公开实例部署版本与该 commit 是否完全一致尚未确认。

## 结论

Moni 应固定使用 **Frankfurter v2 的 ECB provider 路由**，显式传入账目日期。默认通用路由混合多个来源，不能将其结果标成 ECB。公共实例无需 API Key，有防滥用限流；无需新增凭据或把个人服务配置写进仓库。[官方 API 文档](https://frankfurter.dev/)

建议取 **EUR 原生报价的两条腿**后在 Moni 内计算交叉汇率。官方单币对路由也可用，但非原生方向已经按量级舍入。日频来源只向前沿用最近 **14 天**内的记录；没有适用报价时返回“待补换算依据”，继续支持手填和实际结算。[精度输出实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2/rate_query.rb#L444-L460)、[回溯实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/carry_forward.rb#L3-L6)

**真实应用链路联调已通过。** 09:12 UTC 的 curl 请求收到 Cloudflare HTTP 403 / error 1010；随后正常 Node 应用客户端经已有代理取得真实报价，并通过受保护本地 Worker/D1 验证。下文保留此前失败观察及后续成功证据，二者差异原因尚未确定。

## 准确请求与响应

固定 origin：`https://api.frankfurter.dev`。使用 JSON，不带 Authorization、Cookie 或金额。

| 用途 | 请求 | 响应形状 |
| --- | --- | --- |
| ECB 单币对 | `GET /v2/providers/ecb/rate/USD/CNY?date=2024-05-15` | 一个 `{date, base, quote, rate}` 对象 |
| ECB EUR 原生报价，推荐 | `GET /v2/providers/ecb/rates?base=EUR&quotes=USD,CNY&date=2024-05-15` | 上述对象数组，每个对象一对币种 |
| 等价筛选路由 | `GET /v2/rate/USD/CNY?providers=ecb&date=2024-05-15` | 与 ECB 单币对相同 |
| 来源信息 | `GET /v2/providers/ecb` | 包含 `key`、`pivot_currency`、覆盖日期及币种等信息 |
| 按来源查询币种 | `GET /v2/currencies?providers=ecb` | 币种及公布日期目录 |
| 实际币对覆盖 | `GET /v2/coverage?base=USD&quotes=CNY&providers=ecb` | `start_date` / `end_date` 可为 null |

这些 endpoint 来自[官方 OpenAPI](https://api.frankfurter.dev/v2/openapi.json)及[仓库内固定版本 OpenAPI](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/public/v2/openapi.json)。覆盖目录的日期不保证任意币对都能互换，不能取两个币种的最早日期来推断币对历史。[官方 coverage 说明](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/README.md#history-coverage)

数组路由参数：`base` 默认为 EUR；`quotes` 是逗号分隔目标币种；`date` 为严格 `YYYY-MM-DD`。区间参数是 `from` / `to`，不能与 `date` 混用；Moni 单笔查询无需区间、分组或最新价。provider 路由已经固定来源，**不要再带 `providers` 参数**，否则服务端校验失败。单币对路由从路径注入大写 base/quote。[路由实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2.rb#L82-L104)、[单币对实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2.rb#L188-L192)、[参数校验](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2/rate_query.rb#L340-L389)

`rate` 是正 JSON number，方向为 **1 base = rate quote**；响应的 `date` 是报价日，不保证等于请求日。字段必须同时核验，不能只读 `rate`。以下仅是合同示意，不是真实响应或已核实行情：

```json
{"date":"YYYY-MM-DD","base":"USD","quote":"CNY","rate":7.2}
```

官方 Rate schema 要求 `date`、`base`、`quote`、`rate`，且 `rate > 0`。[Rate schema](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/public/v2/openapi.json#L458-L496)

## 非报价日、未来日期与精度

- 日频查询在 `[请求日−14 天, 请求日]` 中，对每个 provider/base/quote 取最新观测。周末或休市日因而可返回此前报价，并保留原日期；超过窗口会缺失。ECB 配置为日频。**14 天是当前实现边界，不是 Moni 自行添加的无限沿用政策。** [CarryForward](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/carry_forward.rb)、[按来源的窗口](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/provider.rb#L29-L31)、[快照选择](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2/rate_query.rb#L209-L223)
- 校验器检查日期格式及真实日历日期，**没有禁止未来请求日期**。不传 `date` 的 latest 路径甚至使用 `Date.today + 1`。Moni 必须一直传明确日期，并自己拒绝响应报价日晚于账目日或当前允许日期；不能依赖上游替应用执行此规则。[日期与默认查询范围实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2/rate_query.rb#L328-L432)
- 单一 provider、原生 EUR→目标币种会透传已存数字；反向和交叉方向仍会舍入。当前算法：`>5000` 取整数，`>80` 两位小数，`>20` 三位，`>1` 四位，`>0.0001` 五位，其余六位。它不是统一“保留 12 位小数”。[Roundable 实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/roundable.rb)、[官方精度回归用例](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/spec/versions/v2/rate_query_spec.rb#L982-L1040)
- 数据入库前的 `12` 是 **有效数字**精度清噪，不是每个报价的有效精度承诺。原始 ECB 发布位数因币种而异；不应补出虚假精度。[入库精度实现](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/rate_precision.rb)

ECB 通常在工作日约 16:00 CET 发布，TARGET 休市日不发布；参考价用于信息展示，不保证还原银行卡结算。Moni 显示实际报价日，允许实际主币结算覆盖。[ECB 官方说明](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

## 币种覆盖

ECB 原生基准为 EUR。2026-10-18 查看的 ECB 当前公布表覆盖 Moni 固定集合中的以下 29 个外币，加 EUR 自身共 30 个：

`AUD BRL CAD CHF CNY CZK DKK GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR`。

Moni 的 `BHD JOD KWD OMR TND` 不在该当前表中，不能通过默认混合来源或挂钩币种推算后标为 ECB；应准备手填/实际结算路径。这只是当前覆盖观察，**没有声称上述五币历史上从未被 ECB 发布过**。每一笔历史币对仍以真实返回为准。[ECB 当前币种表](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)、[指定 provider 排除额外挂钩价的官方测试](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/spec/versions/v2_spec.rb#L1023-L1029)

ECB 种子配置的覆盖起点为 `1999-01-04`，不能据此保证所有币种均从该日有数据。主币与原币相同直接采用 1，无需外部查询。[ECB provider 配置](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/db/seeds/providers/ecb.json)、[覆盖限制说明](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/README.md#history-coverage)

## 最小可靠的 Moni 服务合同建议

以下是基于已批准规格的实现建议，不是新增产品需求：

1. 输入仅接收冻结币种集合中的 `originalCurrency`、`primaryCurrency` 和已校验日期；使用固定官方 origin 与固定 ECB 路由。只发币种/日期，限制响应大小与耗时，拒绝跳转和非成功响应。
2. 同币返回精确 1；异币发一次 EUR 原生数组请求，只取所需两币。EUR 本身的腿精确设为 1；不要把 API 合成 identity 行的日期当成 EUR 的发布证据。两条非 EUR 腿均须存在、唯一、base=EUR、币种匹配、有限正数、报价日期合法且相同。
3. 两腿日期不同、晚于请求日/允许日期、超出上游日频窗口，或缺失时拒绝自动折算。跨日记录不能拼出一个声称“同日 ECB”的币对。日期不同场景可直接待补，无需增加逐日回探网络调用。
4. 用项目既有精确十进制/BigInt 算法计算 `EUR→主币 ÷ EUR→原币`，转为项目允许精度的十进制汇率；随后遵循既有确认与金额舍入规则。建议同时保存来源标识、两个原生报价及实际报价日，便于解释交叉价。确认快照必须包含最终采用值，历史报表不重新访问行情。
5. 输出有报价时包含固定来源 `ECB via Frankfurter`、明确方向、实际报价日及采用汇率；无报价/服务不可用时保留可编辑待补状态。返回给前端的可选错误种类可为“缺少报价”和“暂时不可用”，不要回传原始错误正文。

第 2–4 项是避免上游交叉舍入及错拼日期的设计推论，依据[单来源交叉计算](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/base_conversion.rb#L56-L75)与[原生精度保留](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2/rate_query.rb#L444-L460)。如果选择更短的单币对请求，应明确接受上游已舍入交叉价，并冻结其值。

## 错误与真实公共 API smoke

官方应用错误合同为 JSON；无可推导单币对返回 404，非法日期/参数/币种等校验失败为 422，OpenAPI 也列出 503。数组路径可能成功返回空数组，不能将 HTTP 200 等同有价。CDN/网络失败可能发生在应用之前，仍须处理非合同 JSON、HTML、403、429、5xx 和超时。[路由错误行为](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/lib/versions/v2.rb#L188-L192)、[无历史数据回归测试](https://github.com/lineofflight/frankfurter/blob/f3529f1eb41a2fd952e82243517e34a79a42d044/spec/versions/v2_spec.rb#L594-L599)、[官方 OpenAPI](https://api.frankfurter.dev/v2/openapi.json)

2026-10-18 09:12:17–09:12:18 UTC，从本机已有回环代理出站，仅发匿名 GET 与 `Accept: application/json`。第一批并行请求全部是 HTTP **403**，JSON 标识 `error_code: 1010`、`error_name: browser_signature_banned`、`retryable: false`。收到拒绝后没有换 User-Agent 或其他路径规避限制。

| 实际请求 | 实际结果 | 本次不能据此确认的行为 |
| --- | --- | --- |
| `/v2/providers/ecb` | 403 / 1010 | 公共实例 provider 实际覆盖元数据 |
| `/v2/providers/ecb/rate/USD/CNY?date=2024-05-15` | 403 / 1010 | 普通工作日成功报价 |
| `/v2/providers/ecb/rate/USD/CNY?date=2024-05-19` | 403 / 1010 | 周日返回前一工作日报价 |
| `/v2/providers/ecb/rate/USD/CNY?date=2024-01-01` | 403 / 1010 | 元旦向此前报价回溯 |
| `/v2/providers/ecb/rate/BHD/CNY?date=2024-05-15` | 403 / 1010 | 该历史日期缺币对的实际应用状态码 |
| `/v2/providers/ecb/rate/ABC/CNY?date=2024-05-15` | 403 / 1010 | 非法币种实际应用 422 |
| `/v2/providers/ecb/rate/USD/CNY?date=2099-01-01` | 403 / 1010 | 远未来日期的实际应用结果 |
| `/v2/providers/ecb/rate/USD/CNY?date=1998-12-31` | 403 / 1010 | 历史起点之前的实际缺价响应 |
| `/v2/providers/ecb/rate/USD/CNY?date=2024-02-30` | 403 / 1010 | 非法日历日期实际应用 422 |
| `/v2/providers/ecb/rates?base=EUR&quotes=USD,CNY&date=2024-05-15` | 403 / 1010 | 推荐两腿报价成功与精度 |
| `/v2/rate/USD/CNY?providers=ecb&date=2024-05-15` | 403 / 1010 | 别名路由与 provider 路由实际等价性 |
| `/v2/openapi.json` | 本机 403 / 1010 | 本机连接公共报价域的可用性 |

这些是本次真实 HTTP 观察，不是上游业务规则推断。官方网页通过 Jina 读取成功，固定 commit 原始源码读取成功；官方 Web 阅读工具也能读取 OpenAPI。它们支持文档核实，**不替代 Moni 运行环境的真实成功报价验收**。表中链接可按固定 origin 拼接复核；没有记录 IP、请求凭据或个人配置。

后续真实应用复验：`scripts/real-fx-smoke.mjs` 使用正常 Node 客户端和本机已有代理，经受保护的编译后 Worker 与真实临时 D1 请求推荐的 EUR 原生数组路由。4 次上游均返回 200；USD/CNY 2024-05-15 来源与方向正确，2024-05-19 实际报价日为 2024-05-17，2024-01-01 实际报价日为 2023-12-29；BHD/CNY 缺失完整币对，应用拒绝为 424。另验证确认保存、备注编辑不取新价、回读固定金额及不保存缺价凭据。该成功范围没有覆盖表中其余非法参数路由，不替它们声称线上通过。

完整本地与真实证据见 [S3 历史报价验收](../verification/s3-reference-quotes.md)。没有执行云资源创建或部署，生产环境出口仍需部署阶段验收。
