# 微信统计摘要与图表发送核查

核查日期：2026-10-19。范围是 Moni 使用的 ClawBot / iLink 私聊入口，不借用公众号、企业微信或其他聊天产品的能力结论。本次仅查阅主来源和已安装包源码，没有读取私密配置或真实账目，没有发送图片或创建云资源。

## 结论

- 统计答复可以继续采用已有 Markdown 文本能力：突出总额、时间范围、统计口径和分组排名。原生图片消息也有官方发送实现，但它是独立媒体消息，不能把 Markdown 图片语法当成图表发送接口；官方过滤器会直接移除 `![alt](url)`。[官方 Markdown 过滤规则](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.ts#L1-L20)
- 无需先把账单图表发布成公网 URL。服务端可生成 PNG 字节，取得腾讯 CDN 上传参数，加密上传后发送图片引用。腾讯现有发送实现会先发说明文字，再发图片，两次请求各携带一个 `item_list` 元素和独立的 `client_id`。[上传流程](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts#L59-L120)、[分开发送文本和图片](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L188-L257)
- 当前 Moni 尚未接通图片上传链路。已安装 SDK 有相关原语，但高层文件上传依赖文件路径，且部分行为落后于官方当前实现；不可把“库有图片函数”表述成“Moni 图片发送已经可用”。[SDK 上传源码](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/media/upload.ts#L39-L104)

## 官方协议与实际发送行为

固定核查 Tencent/openclaw-weixin 提交 `874637a0dbc24050f72d1385add4fc6170a2d726`，与核查时官方 `main` 一致。

1. 生成图片明文，计算 `rawsize`、`rawfilemd5` 和加密后 `filesize`；生成随机 16 字节 AES key 与 file key。
2. 以 `media_type: 1`、接收人及这些元数据调用 `POST /ilink/bot/getuploadurl`。官方实现使用 `no_need_thumb: true`，不另做缩略图。[官方协议](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md#L250-L299)
3. 使用 AES-128-ECB 和 PKCS#7 填充加密文件，向上传地址发送 `application/octet-stream`，读取成功响应的 `x-encrypted-param`。[官方加密上传](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/cdn-upload.ts#L10-L109)
4. 官方当前实现优先使用 `upload_full_url`；没有时才以 `upload_param` 与 file key 拼接 CDN 地址。[上传地址选择](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts#L95-L112)
5. 通过 `sendmessage` 发送 `type: 2` 的 `image_item`，其中 `media.encrypt_query_param` 指向刚上传的图片，`media.encrypt_type: 1`，`mid_size` 是密文字节数。官方发送器将 AES key 的十六进制字符串再进行 base64 编码；实现时要遵循这个已存在的编码约定。[图片消息构造](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L267-L314)

PNG、JPG/JPEG 均在官方 MIME 映射表里，并按 `image/*` 分流到图片上传与发送。SVG 不在该映射表中，因此可将 SVG 用作内部绘图中间格式，发送前转成 PNG。[MIME 映射](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/media/mime.ts#L1-L47)、[媒体类型分流](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send-media.ts#L24-L70)

本次检查的官方协议、上传器和发送器没有给出可据此承诺的图片最大字节数、最大尺寸或每日发送配额。不能把其他微信产品的 2 MB / 10 MB 等数字套用过来。Moni 可以自设保守的尺寸、编码字节数和请求时限，但应标明是应用限制，之后用合成数据真实联调确认。

## 已安装 SDK 与 Worker 适用性

核查本机 `wechat-ilink-client@0.1.0` 的 `dist/index.mjs`、类型声明和仓库源码。源码固定到 `b3e59440e90da344667b5d38af122fdd77a8d2a3`。

| 能力 | 当前事实 | Moni 接入含义 |
| --- | --- | --- |
| 高层 `uploadImage` | 从 `filePath` 调用 `node:fs/promises.readFile`，再计算哈希和上传；只使用 `upload_param` | Worker 内已有图片字节时，不必绕回文件路径；还要兼容官方的 `upload_full_url`。[源码](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/media/upload.ts#L39-L104) |
| 低层 `uploadBufferToCdn` | 可接收 Buffer，内部加密、直接调用全局 `fetch`，最多尝试三次；未提供 fetch 注入和超时参数 | 不能指望现有 ApiClient 的私有 transport 自动保护 CDN 请求，需要有界、校验后的媒体传输。[源码](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/cdn/cdn-upload.ts#L13-L74) |
| `sendImage` 的 caption | 先构造文本元素，再构造图片元素，遍历时每个元素独立调用发送接口 | 可组合 Markdown 摘要与图表，但通常表现为相邻两条消息；不能保证同一个图文气泡。[源码](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/media/send.ts#L84-L118) |
| Node 加密原语 | SDK 使用 `node:crypto` 的哈希和 AES；Cloudflare 官方说明 `node:crypto` 在兼容模式下可用，并列出例外 | 有可行基础，仍需真实 Worker 集成测试验证使用的 AES/MD5 分支；不能只以普通 Node 测试证明边缘运行。[Cloudflare 文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) |

Moni 当前 `src/lib/wechat-api.ts` 只分派二维码、扫码状态、接收、发送四类操作；尚未分派 `getuploadurl`。仓库对 SDK 的 fetch 注入补丁只修改 ApiClient，不覆盖 CDN 上传器的全局 fetch。上述判断是本地代码核查结果，不是一次真实媒体联调的结论。

## 最小安全实现路线（方案，尚未验收）

1. **继续由程序计算统计数据。** 同一份可信查询结果同时生成 Markdown 和图表，AI 只负责理解筛选与分组条件；不能由模型另造图表数字。空结果、只有合计、分组过多时，优先保留清楚的文字摘要。
2. **在服务端内存生成 PNG。** 可用固定 SVG 模板配合 `@resvg/resvg-wasm`；其官方实现支持 SVG 转 PNG、自定义 `fontBuffers`，无需第三方制图服务。SVG 文本必须转义，禁止模型提供可执行配置、外链图片、远程字体。中文标签需要随部署打包合适授权的字体或字体子集。[resvg 官方能力](https://github.com/yisibl/resvg-js/blob/9de8ddd9dd62293006d849dd846a3b91ba992f23/README.md#L17-L23)、[Wasm 与字体 Buffer](https://github.com/yisibl/resvg-js/blob/9de8ddd9dd62293006d849dd846a3b91ba992f23/README.md#L156-L195)
3. **只走已认证的腾讯上传与当前会话。** 校验上传响应、HTTPS、明确允许的腾讯 CDN 主机和跳转；对上传字节数、下载响应、请求时间和重试次数设限。图片字节不必落磁盘、进入公开素材目录、业务备份或公共对象存储。
4. **发送状态分开保存。** Markdown 已发成功、图片上传失败、图片发送失败分别记录；重试图片不能重复发送文字，更不能重做查账或写入任何账目。媒体 key、下载参数、上下文令牌按现有私密会话策略保护，日志只记录无敏感值的阶段与错误类别。
5. **失败降级为可读文字。** 图表只是补充，图片生成或上传失败不应阻塞统计答复。首次仅做一类分组条形图，再按确认的需要扩展；趋势图要求相应完整的日期分桶数据。

这条路线不需要新增云资源、公网账单图表 URL、R2 或第三方图表网站。新增 Wasm 渲染器仍要核验 Worker 打包、字体、CPU、内存和输出大小；不能把锁文件里的开发工具间接依赖 `sharp` 当成可直接在 Worker 使用的渲染器。

## 验证边界

| 层级 | 本次状态 |
| --- | --- |
| 官方协议支持 | 已核查图片上传、加密与消息引用，固定提交链接如上 |
| SDK 实现 | 已核查本机 0.1.0 和对应源代码，明确文件接口及 transport 差异 |
| Moni 已接通图片 | 未实现；本报告不代表运行验证 |
| PNG 图表 Worker 运行 | 未安装渲染器，未做 CPU/内存和中文字体验收 |
| 微信真实图片接收 | 未测试；需合成统计数据确认发送响应和手机显示，二者分别记录 |

发送到微信意味着图片内容会交给微信平台处理；加密上传流程不等于额外承诺微信无法读取内容。这里保障的是不将账目送到无关第三方制图网站、不公开发布图表，以及不在开源代码或日志留下凭据。
