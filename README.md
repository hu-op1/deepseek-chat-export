# DeepSeek 对话备份（deepseek-chat-export）

把 DeepSeek 网页端（chat.deepseek.com）**你自己账号**的全部历史对话，完整备份成本地 JSON。

网页端没有全量导出功能，也没有记忆——换个设备、清理缓存、或者哪天想翻回去看看，就都没了。
这个脚本就是把它们抓下来存在硬盘里，跑第二遍时只抓新增和有改动的内容。

## 三步开始

需要 Node.js 20 以上（你这里已经是 v24）。

```powershell
cd E:\code\ds对话获取

# 1) 先确认接口还在（不需要登录）
node export.mjs --self-test

# 2) 先抓 3 个试试，看看内容对不对
node export.mjs --limit 3

# 3) 满意了再全量
node export.mjs
```

第 2 步会停下来要一次登录凭证，按屏幕提示做就行：

1. 浏览器打开 chat.deepseek.com 并确认已登录
2. F12 → Console，粘贴执行 `copy(JSON.stringify(localStorage))`
3. 回到终端，Ctrl+V 粘贴、回车

这一步只是把**你自己浏览器的登录信息**复制到剪贴板，脚本只会用它去请求 DeepSeek 自己的接口，
不会发往任何第三方。凭证会缓存到 `data/.token`，下次不用再弄；删掉这个文件即可作废。

## 备份长什么样

```
data/
  index.json                     # 汇总表：标题、时间、消息数、对应文件
  sessions/
    2024-11-15_关于人生的意义__3f2a9c1b.json
    2024-11-20_帮我写个爬虫__7b0d4e88.json
    ...
```

一个对话文件：

```json
{
  "schema": 1,
  "fetchedAt": "2026-11-04T15:50:02.000Z",
  "session": { "…列表接口返回的原始对象，一个字段都没动…": "" },
  "messages": [ "…每一条消息的原始数据，思考过程也在里面…" ]
}
```

原则是**只加包装、不改内容**：上游返回什么就存什么，将来想拿它做 Markdown、做成回忆集、
或者喂给别的 AI 当上下文，都不用重新联网抓一遍。

## 常用命令

```powershell
node export.mjs --help           # 所有选项
node export.mjs --self-test      # 只探测接口，不导数据
node export.mjs --dry-run        # 只列出"哪些会被抓"，不下载内容
node export.mjs --limit 10       # 只处理最近 10 个
node export.mjs --full           # 忽略增量状态，全部重抓
node export.mjs --out D:\备份\ds # 换输出目录
node export.mjs --token eyJ...   # 直接指定 token（不做交互）
```

退出码：`0` 全部成功，`1` 有失败项，`2` 登录凭证有问题，`3` 列表可能没抓全。

## 重复跑是安全的

`data/index.json` 里记着每个对话的更新时间和消息数，再跑的时候：

- 新对话 → 抓
- 时间或消息数变了 → 覆盖重抓（文件名跟着变，旧文件自动删除）
- 没变 → 跳过，只打印数量

所以你可以隔一段时间跑一次当增量备份。中途 Ctrl+C 也不怕：已经写好的文件都在，
索引也是每抓完一个就落盘，重跑会自动接着抓。

## 接口改版了怎么办

这工具随时可能因为 DeepSeek 改版而失效。两层防线：

1. **`--self-test`**：不需要登录就能判断"是接口没了，还是我的凭证过期了"。
2. **cURL 重放模式**：完全绕开 token，直接把你浏览器里那条真实请求原样重放。

```powershell
# F12 → Network → 刷新页面 → 找到 chat_session/fetch_page
# 右键 → Copy → Copy as cURL，存进 request.txt（bash/cmd/PowerShell 格式都认）
node export.mjs --from-curl request.txt
```

这个模式只改请求里的分页参数和 `chat_session_id`，其余请求头原样保留，
所以即使接口加了新校验也能继续用。

## 主题图谱（可选）

备份完之后，可以把 497 个对话变成一张「我这两年都在关心什么」的图。
**这一步需要你自己接一个模型**（OpenAI 兼容协议，DeepSeek 官方、OpenRouter、硅基流动、本地 vLLM 都行）。

```powershell
# 1) 先标 20 个，看看模型给的标签准不准
node tools/topics.mjs --base-url https://api.deepseek.com/v1 --model deepseek-chat --limit 20

# 2) 满意后全量（已标的自动跳过，可以断点续跑）
node tools/topics.mjs --base-url https://api.deepseek.com/v1 --model deepseek-chat

# 3) 生成图谱和页面
node tools/graph.mjs --open
```

API Key 用 `--api-key` 传，或者放环境变量 `DS_API_KEY`。

产出：

```
memory/
  topics/<id>.json   每个对话的标注（可以手工改，改完只需重跑 graph）
  canonical.json     原始标签 → 30 个规范主题的映射
  graph.json         聚合结果
  graph.html         双击打开的可视化页面（自包含，无 CDN）
```

页面有三个部分：**主题流向**（每个月各主题的对话数）、**主题网络**（哪些关心常一起出现）、
**详情面板**（点任一主题看它的对话）。

成本：497 次调用、约 200 万字符输入，用 DeepSeek 官方价是几块到几十块；
接自己的模型按你的价算。`memory/` 含对话标题和摘要，**已加进 `.gitignore`，不会入库**。

设计取舍写在 [主题图谱设计文档](docs/superpowers/specs/2026-11-04-topic-graph-design.md)，
包括为什么**不用嵌入直接聚类**——简单说：簇没有名字，最后还是得让模型起名，多绕两层还丢了可解释性。

## 已知的局限

- 只备份**当前登录账号**的对话，不涉及别人的数据；请勿把导出的内容到处传播。
- 会话列表用 `(pinned, updated_at)` 游标分页，`count` 上限 100。任何一道"游标没前进"的闸触发时，
  脚本会**明确警告"可能没抓全"**并以退出码 `3` 结束，而不是假装成功。
  实测 497 个对话 / 6 页可完整抓完。
- 网页端删除的对话，本地文件不会被删除（删除网页 ≠ 你想销毁本地备份），只在汇总里提示数量。
- 单个对话可能有几 MB（长对话 196 条消息 ≈ 2MB），因为 JSON 保留了每条消息的全部字段。
  要省空间可以自己压缩，或者告诉我加一个 `--compact` 开关。

## 接口细节（自己改代码时看这里）

都是实测出来的，猜是猜不到的：

| 项目 | 结论 |
| --- | --- |
| 鉴权 | `Authorization: Bearer <localStorage.userToken 的 value>` |
| token 形态 | 64 位不透明串，**不是 JWT** |
| 大坑 | localStorage 里还有个 `settingsJwt`，里面嵌着真 JWT，按形状嗅探会错抓它 |
| 分页 | `?count=100&lte_cursor.updated_at=<秒>&lte_cursor.pinned=<bool>` |
| 单位 | `updated_at` 必须是**秒**，传毫秒直接 HTTP 400 |
| `lte_cursor.pinned` | **必填**，不传则游标被静默忽略，永远返回第一页 |
| `count` | 上限 100，传 200 会静默返回 0 条 |
| 无效参数 | `offset` / `page` / `before_id` / `after_id` / `seq_id` 全部无效 |
| 消息正文 | **不在 `content`**，在 `fragments[].content` |
| 消息分页 | 无，一次返回全部 |
| 限流 | HTTP **200** + `code 40029 TOO_MANY_REQUESTS`（不是 429！只看 HTTP 状态码会漏掉） |

限流这条是踩出来的：第一版只认 HTTP 429，结果一次全量跑下来 450 成功、47 个被静默判死。
现在 `40029` 会触发指数退避重试，同时把全局请求节奏自动拉长，成功后慢慢恢复。

## 开发

```powershell
node --test        # 75 个测试，全部不依赖外网
```

测试里有本地假服务器：一个模拟 DeepSeek 的备份接口，一个模拟 OpenAI 兼容的模型端点，
所以"抓取 → 落盘 → 二次跳过"和"标注 → 归并 → 出图"两条链路都能在离线状态下验证。

```
export.mjs           备份入口
tools/topics.mjs     标注 + 归并
tools/graph.mjs      聚合 + 渲染页面

lib/auth.mjs         token 嗅探（不依赖 localStorage 键名，字段名优先级高于 JWT 形状）
lib/curl.mjs         cURL 解析与请求推导
lib/extract.mjs      响应归一化（路径找不到时按形状识别）
lib/api.mjs          传输层：两种模式、重试、退避、错误分类、游标分页
lib/store.mjs        文件名、索引、增量差异、原子写入
lib/llm.mjs          OpenAI 兼容客户端 + JSON 容错提取
lib/topics.mjs       提示词、标注归一化、标签归并、聚合（纯函数，可单测）
lib/graph-html.mjs   图谱页面渲染（自包含 HTML）
lib/args.mjs         命令行参数解析
docs/                设计文档
```
