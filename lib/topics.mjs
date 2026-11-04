/**
 * 主题标注与聚合的纯逻辑（不碰网络，可单测）。
 *
 * 设计要点：
 *   1. 标注按"对话"粒度，不按消息——4617 条消息切碎后每个片段都不足以下判断；
 *   2. 输入必须截断：最长单个对话 48 万字符，远超任何上下文；
 *   3. 自由标签必须归并，否则"代码/编程/写程序"会分裂成三个主题，图谱直接失效。
 */

/** 从备份的会话 JSON 里抽出可读消息（正文在 fragments[].content）。 */
export function sessionMessages(sessionJson) {
  const out = [];
  for (const message of sessionJson?.messages ?? []) {
    const parts = [];
    for (const fragment of message?.fragments ?? []) {
      if (typeof fragment?.content === 'string' && fragment.content.trim()) parts.push(fragment.content);
    }
    const text = parts.join('\n').trim();
    if (!text) continue;
    out.push({ role: message?.role ?? 'USER', text });
  }
  return out;
}

export function formatMessages(messages) {
  return messages
    .map((m) => `【${m.role === 'USER' ? '我' : 'AI'}】${m.text.trim()}`)
    .filter((line) => line.length > 6)
    .join('\n');
}

/**
 * 取第一条用户提问。
 * 摘要显示别用整段对话——模型的思考过程（"用户想知道……我需要搜索……"）
 * 会把真正的问题挤掉，扫一眼根本看不出这段对话在聊什么。
 */
export function firstUserText(messages, maxChars = 160) {
  const hit = messages.find((m) => m.role === 'USER' && m.text.trim().length > 2);
  const text = (hit ?? messages[0])?.text ?? '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

/**
 * 截断成"开头 + 中间抽样 + 结尾"，保证长对话也能被正确归类。
 * 单纯 slice 头部会丢掉结论，单纯截尾会丢掉问题。
 */
export function buildSnippet(messages, maxChars = 6000) {
  const text = formatMessages(messages);
  if (text.length <= maxChars) return { text, truncated: false, fullChars: text.length };

  const head = Math.floor(maxChars * 0.45);
  const tail = Math.floor(maxChars * 0.45);
  const midLen = Math.max(0, maxChars - head - tail - 40);
  const midStart = Math.max(head, Math.floor(text.length / 2 - midLen / 2));
  const marker = '\n\n……（中间省略）……\n\n';

  const pieces = [text.slice(0, head)];
  if (midLen > 200) pieces.push(text.slice(midStart, midStart + midLen));
  pieces.push(text.slice(-tail));

  return { text: pieces.join(marker), truncated: true, fullChars: text.length };
}

export function monthOf(millis) {
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const d = new Date(millis);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ───────────────────────── 标注 ───────────────────────── */

export const ANNOTATION_SYSTEM = [
  '你是一个对话主题标注器。用户会给你一段他与 AI 助手的对话摘录。',
  '你只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。',
].join('\n');

export function annotationPrompt({ title, month, snippet, truncated }) {
  return [
    `对话标题：${title || '(无标题)'}`,
    `时间：${month ?? '未知'}`,
    truncated ? '注意：下面是截断后的摘录（开头、中段、结尾）。' : '',
    '',
    '摘录：',
    snippet,
    '',
    '请输出这个 JSON：',
    '{"topics":[{"label":"中文名词短语，4-10 字","weight":0.0到1.0}],',
    ' "entities":[{"name":"具体名词：技术/产品/地名/组织","type":"technology|product|place|org|person|other"}],',
    ' "summary":"一句话概括，不超过 40 字"}',
    '',
    '要求：',
    '- topics 给 2-5 个，按重要性降序，weight 表示这段对话有多聚焦在这个主题',
    '- label 要具体、可区分，不要用"闲聊""问答""问题"这类空标签',
    '- entities 最多 8 个，只写对话里真的出现过的专有名词',
    '- summary 必须基于摘录内容，不要编造',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 把模型输出收敛成稳定结构；脏数据一律丢弃而不是塞进图谱。 */
export function normalizeAnnotation(raw) {
  const seen = new Set();
  const topics = [];

  for (const item of Array.isArray(raw?.topics) ? raw.topics : []) {
    const label = String(typeof item === 'string' ? item : (item?.label ?? '')).trim().replace(/\s+/g, ' ');
    if (!label || label.length > 20) continue;
    if (seen.has(label)) continue;
    seen.add(label);

    const rawWeight = Number(typeof item === 'object' ? item?.weight : 1);
    const weight = Number.isFinite(rawWeight) ? Math.min(1, Math.max(0.05, rawWeight)) : 1;
    topics.push({ label, weight });
    if (topics.length >= 6) break;
  }

  const entities = [];
  const entitySeen = new Set();
  for (const item of Array.isArray(raw?.entities) ? raw.entities : []) {
    const name = String(typeof item === 'string' ? item : (item?.name ?? '')).trim();
    if (!name || name.length > 30 || entitySeen.has(name)) continue;
    entitySeen.add(name);
    entities.push({ name, type: String(item?.type ?? 'other').trim() || 'other' });
    if (entities.length >= 10) break;
  }

  const summary = String(raw?.summary ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return { topics, entities, summary };
}

/* ───────────────────────── 归并 ───────────────────────── */

export const MERGE_SYSTEM = [
  '你是一个标签归并器。用户会给你一批自由生成的主题标签及其出现次数。',
  '你要把它们合并成数量受控的规范主题。只输出 JSON 对象。',
].join('\n');

/**
 * 归并目标数量。
 * 早先固定"归并成 30 个"，但小样本时（比如 22 个原始标签）这个目标自相矛盾，
 * 模型会在思考里直接吐槽"impossible"，然后把预算烧光。所以按标签数自适应。
 */
export function mergeTarget(labelCounts, grain = 30) {
  return Math.min(grain, Math.max(5, Math.round(labelCounts.length * 0.7)));
}

export function mergePrompt(labelCounts, targetCount = 30) {
  const lines = labelCounts.map((item) => `${item.label}\t${item.count}`).join('\n');
  return [
    `下面是 ${labelCounts.length} 个原始主题标签（标签 TAB 出现次数）：`,
    '',
    lines,
    '',
    `请把它们归并成**不超过 ${targetCount} 个**规范主题：`,
    '1. 语义相近或包含关系的标签必须合并（如 "代码"/"编程"/"写程序" → 一个主题）',
    '2. 每个输入标签都必须出现在某个主题的 aliases 里，一个都不能丢',
    '3. 规范主题的 label 用 4-10 字的中文名词短语，彼此可区分',
    '4. 频次低、语义孤立的零散标签合并进"其他"',
    '5. 数量可以少于上限，不要为了凑数硬拆',
    '',
    '输出：{"topics":[{"id":"t1","label":"规范主题名","aliases":["原始标签1","原始标签2"]}]}',
  ].join('\n');
}

export function normalizeMerge(raw, knownLabels) {
  const known = new Set(knownLabels);
  const topics = [];
  const used = new Set();

  for (const [index, item] of (Array.isArray(raw?.topics) ? raw.topics : []).entries()) {
    const label = String(item?.label ?? '').trim();
    if (!label) continue;

    const id = String(item?.id ?? `t${index + 1}`).trim() || `t${index + 1}`;
    if (used.has(id)) continue;
    used.add(id);

    const aliases = (Array.isArray(item?.aliases) ? item.aliases : [])
      .map((a) => String(a).trim())
      .filter((a) => a && known.has(a));

    // 规范名本身也可能就是一个原始标签
    if (known.has(label) && !aliases.includes(label)) aliases.push(label);

    topics.push({ id, label, aliases });
  }

  // 兜底：模型漏掉的标签单独归到"其他"，绝不静默丢弃。
  // 但如果模型压根没给出任何主题，就不要捏造一个只含"其他"的假映射——
  // 那会让下游误以为归并成功，产出的图谱全是"其他"，比直接失败更难发现。
  const covered = new Set(topics.flatMap((t) => t.aliases));
  const missing = knownLabels.filter((label) => !covered.has(label));
  if (missing.length && topics.length > 0) {
    const other = topics.find((t) => t.label === '其他');
    if (other) other.aliases.push(...missing);
    else topics.push({ id: 'other', label: '其他', aliases: missing });
  }

  return { topics, missing };
}

/* ───────────────────────── 聚合 ───────────────────────── */

/**
 * @param {{records: any[], canonical: {topics: {id:string,label:string,aliases:string[]}[]}}} input
 */
export function aggregate({ records, canonical, maxEdges = 240, minEdgeWeight = 1 }) {
  const aliasToId = new Map();
  for (const topic of canonical.topics) {
    aliasToId.set(topic.label, topic.id);
    for (const alias of topic.aliases ?? []) aliasToId.set(alias, topic.id);
  }

  const topics = new Map();
  const byMonth = {};
  const countsByMonth = {};
  const conversations = {};
  const edgeCounts = new Map();
  const unmapped = new Map();

  for (const record of records) {
    const ids = new Set();
    for (const topic of record.topics ?? []) {
      const id = aliasToId.get(topic.label);
      if (!id) {
        unmapped.set(topic.label, (unmapped.get(topic.label) ?? 0) + 1);
        continue;
      }
      ids.add(id);
    }
    if (ids.size === 0) continue;

    const month = record.month ?? null;
    const idList = [...ids];

    for (const id of idList) {
      if (!topics.has(id)) topics.set(id, { id, count: 0, months: {}, conversations: [] });
      const stat = topics.get(id);
      stat.count += 1;
      stat.conversations.push(record.id);
      if (month) stat.months[month] = (stat.months[month] ?? 0) + 1;
    }

    if (month) {
      byMonth[month] ??= {};
      for (const id of idList) byMonth[month][id] = (byMonth[month][id] ?? 0) + 1;
      countsByMonth[month] = (countsByMonth[month] ?? 0) + 1;
    }

    for (let i = 0; i < idList.length; i += 1) {
      for (let j = i + 1; j < idList.length; j += 1) {
        const key = [idList[i], idList[j]].sort().join('|');
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }

    conversations[record.id] = {
      title: record.title ?? '',
      month,
      // 具体到天的时刻：只给月份的时候，同一个月里几十段对话排不出先后
      date: record.at ?? null,
      topics: idList,
      summary: record.summary ?? '',
    };
  }

  // 边数要跟着主题规模走：70 个主题画 240 条边就是一坨毛线。
  // 每个节点平均 3 条边是上限，最少给 40 条。
  const edgeCap = Math.min(maxEdges, Math.max(40, topics.size * 3));

  const edges = [...edgeCounts.entries()]
    .map(([key, weight]) => {
      const [a, b] = key.split('|');
      return { a, b, weight };
    })
    .filter((edge) => edge.weight >= minEdgeWeight)
    .sort((x, y) => y.weight - x.weight)
    .slice(0, edgeCap);

  const labelOf = new Map(canonical.topics.map((t) => [t.id, t.label]));
  const topicList = [...topics.values()]
    .map((stat) => {
      const months = Object.keys(stat.months).sort();
      return {
        id: stat.id,
        label: labelOf.get(stat.id) ?? stat.id,
        count: stat.count,
        months: stat.months,
        first: months[0] ?? null,
        last: months.at(-1) ?? null,
        conversations: stat.conversations,
      };
    })
    .sort((x, y) => y.count - x.count);

  const months = [...new Set([...Object.keys(byMonth), ...records.map((r) => r.month).filter(Boolean)])].sort();

  // 最后一次活动时间：用来判断最后一个月是不是残缺月（只到几号），避免把断崖画成趋势
  const stamps = records
    .map((r) => (r.at ? Date.parse(r.at) : NaN))
    .filter((value) => Number.isFinite(value));

  return {
    generatedAt: new Date().toISOString(),
    lastAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    counts: {
      conversations: Object.keys(conversations).length,
      topics: topicList.length,
      edges: edges.length,
      unmappedLabels: unmapped.size,
    },
    months,
    topics: topicList,
    edges,
    byMonth,
    countsByMonth,
    conversations,
    unmapped: [...unmapped.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  };
}
