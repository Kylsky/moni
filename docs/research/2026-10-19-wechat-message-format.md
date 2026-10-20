# 微信 ClawBot 回复的 Markdown 排版核查

日期：2026-10-19。范围：Moni 当前使用的微信 ClawBot／iLink 入口。方法：通过 agent-reach 的 GitHub CLI 后端读取腾讯官方仓库，并核对官方变更日志、发送实现、过滤器及其测试；未进行扫码、登录、发消息或手机视觉验收。

## 结论

可以采用部分 Markdown 改善草稿排版。腾讯官方插件的变更日志在 2.1.3 记录了从整体移除 Markdown 转为部分保留，2.1.8 再扩大保留范围；当前实现保留中文加粗、常用标题和列表。因此不能把这个入口笼统认定为“只支持纯文本”。[官方变更日志](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/CHANGELOG.zh_CN.md#L129-L164)

核查时 `main` 提交为 `874637a0dbc24050f72d1385add4fc6170a2d726`，提交时间为 2026-10-13。本结论以此版本为边界，不构成所有微信客户端、其他微信产品或未来版本的完整渲染承诺。[版本提交](https://github.com/Tencent/openclaw-weixin/commit/874637a0dbc24050f72d1385add4fc6170a2d726)

## 协议传输与客户端排版是两回事

官方发送器将内容放入 `type: 1` 的 `text_item.text`；公开类型没有单独的 Markdown 消息种类或 `parse_mode`。这只能说明传输形态，不能据此推断微信不渲染文本中的 Markdown。渠道发送路径先运行 `StreamingMarkdownFilter`，再发送过滤后文本，明确保留了一部分语法。[文本类型](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts#L70-L89)、[文本请求构造](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L56-L79)、[渠道过滤与发送](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L139-L157)

官方协议自身也区分客户端已实现行为与完整服务端契约；不能仅凭某个字段存在，就推定完整能力可用。[协议阅读约定](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md#L7-L15)

## 官方当前实际保留的语法

下表描述官方适配器的输出和测试事实。它提供兼容性依据，不等同于本次已在用户手机上验证每种视觉效果。

| 语法 | 官方过滤行为 | Moni 草稿建议 |
| --- | --- | --- |
| `**中文加粗**` | 原样保留 | 用于草稿状态、消费标题、合计。 |
| H1–H4 标题 | 保留标题标记 | 可用；短草稿优先加粗，避免大标题占屏。 |
| 列表、引用、分隔线 | 保留 | 用列表与空行区分明细，避免过多分隔线。 |
| 表格、行内代码、围栏代码 | 保留 | 不作为账目主布局，手机窄屏读起来较拥挤。 |
| 删除线 | 保留 | 本次无需使用。 |
| H5／H6 标题 | 移除标题标记、保留文字 | 不使用。 |
| 含中日韩文字的斜体／粗斜体 | 移除相应斜体标记、保留文字 | 不使用。 |
| `![图片](地址)` | 移除图片 Markdown | 不将其作为账目草稿渲染方式。 |

来源：[过滤器实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.ts)、[加粗与斜体测试](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.test.ts#L218-L329)、[标题、表格与列表测试](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.test.ts#L332-L505)。

图片、语音、文件和视频另有协议内容类型；公开接口没有通用 HTML 卡片／任意布局消息类型。本次不为改善文字排版扩展媒体发送。[消息内容类型](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md#L404-L418)

## Moni 的最小排版方案

复用现有文字回复，将草稿的同一行密集字段拆成状态、消费、字段、合计和确认提示。金额继续来自服务端财务数据；排版不增加模型调用，也不由模型重算金额。核查后已按下列格式更新 Moni 发送实现；示例为合成账目，不代表已完成真实微信视觉验收：

```markdown
🧾 **已整理为草稿，尚未入账**

**合成超市购物**

**¥155.00** · 支出

- 日期：2026-10-18
- 类目：饮食
- 标签：日常
- 备注：合成单据

---

**合计：¥155.00**

以上账目可以入账吗？核对无误后，直接告诉我就好。
```

多笔消费逐笔分段；有标签时另列标签行。多币种须明确原币和固定折算金额、主币种合计，保留当前汇率事实与待补全提示，避免为了简洁遗漏账务信息。普通回复不恢复固定网页跳转尾巴。

自由输入的标题、类目、标签和备注已转义 Markdown 标记，原始账目不变；多行备注仍保留。多笔逐项编号，超过完整回复长度限制时沿用网页核对路径，不允许对未展示的完整草稿直接确认。没有新增消息类型、配置或依赖。

最终需要在用户当前微信客户端核对中文加粗、换行、长备注及多笔／多币种排版。本次未取得官方客户端完整的 Markdown 兼容表，也未将用户提交但未合并的 Issue／PR 当作腾讯确认事实。
