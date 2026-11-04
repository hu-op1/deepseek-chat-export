# DeepSeek 网页端对话全量备份工具 — 设计文档

日期：2026-11-04
状态：已批准，实施中

## 1. 目标

把 DeepSeek 网页端（chat.deepseek.com）**自己账号**的全部历史对话，完整、可重复地备份到本地磁盘，
用于长期留存（网页端没有记忆功能，也没有全量导出功能）。

非目标（YAGNI）：Markdown/HTML 渲染、PDF、定时任务、GUI、多账号管理。
JSON 是唯一真相源，任何阅读形式都可以由它在本地二次转换，不需要重新联网抓取。

## 2. 事实依据（2026-11-04 实测）

未登录直接请求，得到的是应用层 JSON 错误而不是 404，说明接口健在、只需鉴权：

| 请求 | 响应 |
| --- | --- |
| `GET /api/v0/chat_session/fetch_page?count=1` | `200 {"code":40003,"msg":"INVALID_TOKEN","data":null}` |
| `GET /api/v0/chat/history_messages?chat_session_id=…` | `200 {"code":40003,"msg":"INVALID_TOKEN","data":null}` |
| `GET /api/v0/users/current` | `200 {"code":40002,"msg":"Missing Token","data":null}` |
| `GET /api/v0/<不存在的路径>` | `200 text/html`（SPA 首页兜底） |

由此得到两条可复用的判据：

1. **接口存活判据**：响应是 JSON 且带 `code` 字段 → 接口存在；响应是 HTML → 接口已下线。
   这是 `--self-test` 的实现基础，不需要 token 也能诊断"是接口挂了还是我的 token 过期了"。
2. **鉴权判据**：`code` 为 `40002`/`40003` → token 无效或过期，不是网络问题。

### 2.1 已用真实账号验证的事实（2026-11-04）

| 项目 | 实测结论 |
| --- | --- |
| 鉴权 | `Authorization: Bearer <localStorage.userToken 的 value>` 可用；该 token 是 64 位不透明串，**不是 JWT** |
| localStorage 里的陷阱 | 同一个 localStorage 里有个 `settingsJwt`，里面嵌着真正的 JWT；按"长得像 JWT"去嗅探会错抓它 |
| 会话列表字段 | `id, title, title_type, model_type, pinned, updated_at`（**没有 `seq_id`**） |
| `updated_at` | 浮点秒，如 `1700000000.5` |
| 分页 | `GET /api/v0/chat_session/fetch_page?count=100&lte_cursor.updated_at=<秒>&lte_cursor.pinned=<bool>` |
| 消息正文字段 | **不在 `content`**，而在 `fragments[].content`（`content` 字段不存在） |
| 消息接口分页 | 无，`chat_session_id` 一次返回全部（实测单会话 196 条） |
| 限流 | HTTP **200** + `code 40029 TOO_MANY_REQUESTS`（**不是** HTTP 429） |
| 规模 | 单账号 497 个对话 / 4617 条消息 / 48.7MB，6 页翻完，无重复 |

分页的三个坑（全部实测过）：

- `lte_cursor.updated_at` 传**毫秒**会直接 HTTP 400；
- `lte_cursor.pinned` **必填**，不传则游标被静默忽略——永远返回第一页（假成功，最危险）；
- `count` 上限 100，传 200 会**静默返回 0 条**，看起来像"没有数据"。

另外 `offset` / `page` / `before_id` / `after_id` / `seq_id` 这些常见参数名**全部无效**，
实测都只会重复返回第一页。

## 3. 技术路线与取舍

| 路线 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 直连 API + Bearer token | 快、结构完整、可增量 | 需要复制一次 token | **主路径** |
| B. cURL 重放 | 与接口实现完全解耦，改版也不失效 | 每次要手动复制一条请求 | **逃生舱** |
| C. 页面 DOM 抓取 | 不需要任何凭证 | 慢、丢格式、改版即崩 | 不采用 |

设计要点：A 一旦判定失败（鉴权或结构不认识），**脚本自己提示切 B**，不需要改代码。

## 4. 架构

单一职责的小模块，每个都能脱离网络独立测试：

```
export.mjs            CLI 入口：参数、编排、进度、退出码
lib/auth.mjs          token 嗅探与解析（正则 + JSON 递归扫描，不依赖键名）
lib/curl.mjs          cURL 文本解析（bash / cmd / PowerShell 三种格式）
lib/extract.mjs       响应归一化：容错定位 chat_sessions / chat_messages 数组
lib/api.mjs           传输层：token 模式与 cURL 模式、重试、退避、错误分类
lib/store.mjs         增量状态：索引读写、文件命名、内容哈希、差异计算
```

数据流：

```
token/cURL ──> api.listAll() ──> sessions[]
                                      │
                         store.diff(remote, index)
                                      │
                    ┌─────────────────┴─────────────────┐
                 未变 → 跳过                        新增/有变化 → api.getMessages()
                                                            │
                                                  写 data/sessions/<file>.json
                                                            │
                                                    更新 data/index.json
```

## 5. 数据模型

`data/sessions/<YYYY-MM-DD>_<标题片段>__<id 短哈希>.json`（短哈希 = sha1(id) 前 8 位）：

```json
{
  "schema": 1,
  "fetchedAt": "2026-11-04T15:50:02+08:00",
  "session":   { "…列表接口返回的原始对象，不做删改…": "" },
  "messages":  [ "…history_messages 返回的原始数组，逐条保留…" ]
}
```

原则：**只加包装，不改内容**。上游字段（`thinking_content`、`files`、`message_id`、`inserted_at` 等）
一律原样保留，避免漏掉将来才想用的信息。

`data/index.json`：

```json
{
  "schema": 1,
  "updatedAt": "…",
  "complete": true,
  "sessions": {
    "<id>": {
      "title": "…",
      "created_at": "…",
      "updated_at": "…",
      "file": "2026-11-04_标题__a1b2c3d4.json",
      "message_count": 42,
      "content_hash": "sha256:…",
      "fetched_at": "…"
    }
  }
}
```

文件名含标题便于人眼浏览；标题变化时按 `index.sessions[id].file` 找到旧文件改名，不产生重复。

## 6. 增量同步语义

对每个远端会话：

- 索引里没有 → 抓取
- `updated_at` 或 `message_count` 与索引不同 → 重抓覆盖（同一路径写入，原子替换）
- 都没变 → 跳过
- `--full` → 忽略以上，全部重抓

阈值比较用"不等"而不是"更新"，因为服务端时间格式可能变化，宁可多抓一次也不要漏。
索引里存在但远端列表没有的会话：**不删除本地文件**，只在汇总里报告数量
（网页端删除 ≠ 用户想销毁本地备份）。

## 7. 分页机制

按 `(pinned, updated_at)` 做 keyset 分页（见 2.1）。流程：

1. 不带游标请求一页（返回最新的 100 条）；
2. 取本页最后一条的 `(pinned, updated_at)` 作为下一页游标；
3. 重复直到 `has_more` 为假。

游标是闭区间（`lte`），所以每页首条必然与上一页末条重复，按 id 去重即可。

**防死循环的三道闸**（任何一道触发都会停止并在汇总里明确警告、退出码 3）：
游标没有向前推进、某页没有新增 id、某页为空但 `has_more` 仍为真。

这三道闸是上一版设计留下的教训：早期版本猜测 `offset`/`page`/`seq_id`，
而服务端对未知参数是"忽略并照常返回第一页"，导致脚本**看起来成功了**却只抓到 100 条。
现在宁可大声失败，也不要静默给出一份残缺备份。

宁可**大声失败**，也不静默给出不完整备份——这是本项目最重要的可靠性要求。

## 8. 错误处理

| 情况 | 处理 |
| --- | --- |
| `40002`/`40003` | 立即中止并提示重新复制 token；已抓文件全部保留 |
| 业务层限流 `40029` | HTTP 200 但业务码报"太快"，指数退避重试 + 全局节奏自动放慢（实测漏掉它会 47/497 静默失败） |
| HTTP `429` / `5xx` | 指数退避（1s/2s/4s）+ 抖动，尊重 `Retry-After` |
| 网络错误 | 重试 3 次，仍失败则记录到失败清单，继续处理其余会话 |
| 响应是 HTML | 判定接口下线，建议切 `--from-curl` 模式 |
| 结构不认识 | dump 原始响应到 `_debug/`，报错而不是静默跳过 |
| 用户 Ctrl+C | 已完成的文件与索引均已落盘，重跑即断点续传 |

## 9. 验证方式（验收标准）

1. `node --test` —— 纯函数单测（token 嗅探、cURL 解析、响应提取、差异计算），不依赖网络。
2. `node export.mjs --self-test` —— 无 token 探测接口存活，验证第 2 节的判据。
3. `node export.mjs --limit 3 --dry-run` —— 用真实 token 列清单，检查标题/时间是否正确。
4. `node export.mjs --limit 3` —— 抓 3 个对话，人工打开 JSON 核对内容完整。
5. 连续跑两次全量，第二次应全部 `skipped`（验证增量幂等）。
