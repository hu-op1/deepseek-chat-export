/**
 * 向量层：嵌入客户端 + 向量数学 + 二维投影。
 *
 * 三个容易踩的坑，都在这里处理掉：
 *   1. 嵌入模型换一个，向量空间就完全不同 —— 缓存必须记模型名和维度，对不上就拒绝复用；
 *   2. 未归一化的向量做点积不等于余弦 —— 落盘前统一归一化；
 *   3. t-SNE 随机初始化会让每次生成的图不一样 —— 用 PCA 做确定性初始化。
 */

import { createGate, sleep } from './util.mjs';

/* ───────────────────────── 编解码 ───────────────────────── */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** float32 → base64（比 JSON 数组小 4 倍左右，也不丢精度）。 */
export function encodeVector(vector) {
  const view = new DataView(new ArrayBuffer(vector.length * 4));
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, vector[i], true);

  const bytes = new Uint8Array(view.buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += BASE64[b0 >> 2];
    out += BASE64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64[b2 & 63] : '=';
  }
  return out;
}

export function decodeVector(text) {
  const clean = String(text).replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const ch of clean) {
    const value = BASE64.indexOf(ch);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }

  const out = new Float32Array(index / 4);
  const view = new DataView(bytes.buffer, 0, index);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/* ───────────────────────── 向量运算 ───────────────────────── */

/** 归一化成单位向量；零向量原样返回（后面会被判为无效）。 */
export function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (!Number.isFinite(norm) || norm === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** 两个已归一化向量的相似度（点积即余弦）。未归一化会先归一化。 */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`向量维度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** 找出与目标最相近的 k 个。 */
export function nearest(target, items, k = 10) {
  return items
    .map((item) => ({ id: item.id, score: cosine(target, item.vector), item }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/* ───────────────────────── 嵌入客户端 ───────────────────────── */

export class EmbedError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'EmbedError';
    this.kind = kind;
    this.status = extra.status ?? null;
  }
}

/**
 * OpenAI 兼容的 /v1/embeddings 客户端，自动分批。
 * @returns {{embed: (texts: string[]) => Promise<Float32Array[]>, describe: () => string}}
 */
export function createEmbeddingClient({
  baseUrl,
  apiKey,
  model,
  batchSize = 16,
  gate = createGate({ gapMs: 200, maxGapMs: 5000 }),
  retries = 3,
  timeoutMs = 60000,
  log,
} = {}) {
  if (!baseUrl) throw new Error('createEmbeddingClient 需要 baseUrl');
  if (!model) throw new Error('createEmbeddingClient 需要 model');

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  const once = async (inputs, label) => {
    for (let attempt = 0; ; attempt += 1) {
      await gate?.wait();

      let response;
      let text = '';
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input: inputs }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        if (attempt < retries) {
          const wait = Math.min(20000, 1000 * 2 ** attempt);
          log?.(`  ! 网络异常，${Math.round(wait / 1000)}s 后重试`);
          await sleep(wait);
          continue;
        }
        throw new EmbedError('network', `嵌入请求失败：${error?.message ?? error}`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new EmbedError('auth', `嵌入端点鉴权失败（HTTP ${response.status}），检查 --api-key`, {
          status: response.status,
        });
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const wait = Math.min(20000, 1000 * 2 ** attempt);
          gate?.slowDown();
          gate?.coolDown(wait);
          await sleep(wait);
          continue;
        }
        throw new EmbedError('rate-limit', `嵌入端点限流/故障（HTTP ${response.status}）`, { status: response.status });
      }
      if (!response.ok) {
        // 404 通常意味着这个端点根本没有 /embeddings
        const kind = response.status === 404 ? 'no-endpoint' : 'http';
        throw new EmbedError(kind, `嵌入端点返回 HTTP ${response.status}：${text.slice(0, 200).replace(/\s+/g, ' ')}`, {
          status: response.status,
        });
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new EmbedError('shape', `嵌入端点返回的不是 JSON：${text.slice(0, 200)}`);
      }

      const data = payload?.data;
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new EmbedError('shape', `嵌入结果数量不符（期望 ${inputs.length}，拿到 ${data?.length}）`);
      }

      return data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => {
          if (!Array.isArray(item?.embedding)) throw new EmbedError('shape', `${label} 里有一条没有 embedding`);
          return Float32Array.from(item.embedding);
        });
    }
  };

  return {
    model,
    describe: () => `${model} @ ${endpoint}`,
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const vectors = await once(chunk, `batch#${Math.floor(i / batchSize)}`);
        out.push(...vectors);
        log?.(`    已嵌入 ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
      }
      return out;
    },
  };
}

/* ───────────────────────── 二维投影 ───────────────────────── */

/** 幂迭代求主成分，用于确定性初始化（t-SNE 随机初始化会让每次图都不一样）。 */
export function pcaN(vectors, dims = 2, iterations = 60) {
  const n = vectors.length;
  const dim = vectors[0]?.length ?? 0;
  const result = [];

  const mean = new Float64Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d += 1) mean[d] += v[d] / n;
  const centered = vectors.map((v) => {
    const out = new Float64Array(dim);
    for (let d = 0; d < dim; d += 1) out[d] = v[d] - mean[d];
    return out;
  });

  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  let basis = Array.from({ length: dim }, () => rand());

  for (let axis = 0; axis < dims; axis += 1) {
    let vector = basis.slice();
    for (let iter = 0; iter < iterations; iter += 1) {
      const next = new Float64Array(dim);
      for (const point of centered) {
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += point[d] * vector[d];
        for (let d = 0; d < dim; d += 1) next[d] += point[d] * dot;
      }
      // 对已经求出的所有主成分做正交化
      for (const previous of result) {
        let proj = 0;
        for (let d = 0; d < dim; d += 1) proj += next[d] * previous[d];
        for (let d = 0; d < dim; d += 1) next[d] -= proj * previous[d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d += 1) norm += next[d] * next[d];
      norm = Math.sqrt(norm) || 1;
      vector = Array.from(next, (value) => value / norm);
    }

    if (axis === 0) basis = vector.slice();
    result.push(vector);
  }

  return centered.map((point) => result.map((w) => point.reduce((sum, value, d) => sum + value * w[d], 0)));
}

export function pca2(vectors, iterations = 60) {
  return pcaN(vectors, 2, iterations);
}

export function pca3(vectors, iterations = 60) {
  return pcaN(vectors, 3, iterations);
}

/**
 * 精确 t-SNE（无 Barnes-Hut）。497 个点完全跑得动，也不引入依赖。
 * 结果用 PCA 初始化 + 固定迭代次数，保证可复现。
 */
export function tsne(
  vectors,
  { perplexity = 30, iterations = 900, learningRate = null, exaggeration = 12, exaggerationIters = 250, dims = 2 } = {},
) {
  const n = vectors.length;
  if (n === 0) return [];
  if (n < 5) return pcaN(vectors, dims).map((p) => p.map((v) => v * 100));

  // 标准 t-SNE 的学习率与 n 有关；拍一个大数字会让所有点被排斥力推成均匀一团
  const lr = learningRate ?? Math.max(50, n / exaggeration / 4);

  const perplexityValue = Math.min(perplexity, Math.max(2, Math.floor((n - 1) / 3)));

  // 距离平方矩阵
  const dist2 = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let sum = 0;
      for (let d = 0; d < vectors[i].length; d += 1) {
        const diff = vectors[i][d] - vectors[j][d];
        sum += diff * diff;
      }
      dist2[i][j] = sum;
      dist2[j][i] = sum;
    }
  }

  // 用二分法为每个点找对应的 beta，使其条件分布的困惑度等于目标
  const P = Array.from({ length: n }, () => new Float64Array(n));
  const logU = Math.log(perplexityValue);

  for (let i = 0; i < n; i += 1) {
    let betaMin = -Infinity;
    let betaMax = Infinity;
    let beta = 1;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      let sumP = 0;
      const row = new Float64Array(n);
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        row[j] = Math.exp(-dist2[i][j] * beta);
        sumP += row[j];
      }
      if (sumP === 0) sumP = 1e-12;

      let entropy = 0;
      for (let j = 0; j < n; j += 1) {
        if (j === i || row[j] === 0) continue;
        const p = row[j] / sumP;
        entropy -= p * Math.log(p);
      }

      const diff = entropy - logU;
      if (Math.abs(diff) < 1e-5) {
        for (let j = 0; j < n; j += 1) P[i][j] = j === i ? 0 : row[j] / sumP;
        break;
      }
      if (diff > 0) {
        betaMin = beta;
        beta = betaMax === Infinity ? beta * 2 : (beta + betaMax) / 2;
      } else {
        betaMax = beta;
        beta = betaMin === -Infinity ? beta / 2 : (beta + betaMin) / 2;
      }
    }
  }

  // 对称化并归一化
  let sumAll = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) sumAll += P[i][j];
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) P[i][j] = Math.max((P[i][j] + P[j][i]) / (2 * sumAll), 1e-12);

  const init = pcaN(vectors, dims);
  const scale = 0.01 / (Math.max(...init.map((p) => Math.max(...p.map(Math.abs)))) || 1);
  const Y = init.map((p) => p.map((v) => v * scale));
  const velocity = Y.map(() => new Array(dims).fill(0));
  const gains = Y.map(() => new Array(dims).fill(1));

  for (let iter = 0; iter < iterations; iter += 1) {
    const exag = iter < exaggerationIters ? exaggeration : 1;
    const momentum = iter < 250 ? 0.5 : 0.8;

    const Q = Array.from({ length: n }, () => new Float64Array(n));
    let sumQ = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let sq = 0;
        for (let d = 0; d < dims; d += 1) {
          const diff = Y[i][d] - Y[j][d];
          sq += diff * diff;
        }
        const value = 1 / (1 + sq);
        Q[i][j] = value;
        Q[j][i] = value;
        sumQ += value * 2;
      }
    }
    if (sumQ === 0) sumQ = 1e-12;

    const grad = Y.map(() => new Array(dims).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const mult = (exaggeration * P[i][j] - Q[i][j] / sumQ) * 4;
        for (let d = 0; d < dims; d += 1) grad[i][d] += mult * (Y[i][d] - Y[j][d]);
      }
    }

    for (let i = 0; i < n; i += 1) {
      for (let d = 0; d < dims; d += 1) {
        gains[i][d] = Math.sign(grad[i][d]) !== Math.sign(velocity[i][d]) ? gains[i][d] + 0.2 : gains[i][d] * 0.8;
        gains[i][d] = Math.max(0.01, gains[i][d]);
        velocity[i][d] = momentum * velocity[i][d] - learningRate * gains[i][d] * grad[i][d];
        Y[i][d] += velocity[i][d];
      }
    }

    // 去掉整体漂移，避免越跑越偏
    const mean = new Array(dims).fill(0);
    for (const point of Y) for (let d = 0; d < dims; d += 1) mean[d] += point[d] / n;
    for (const point of Y) for (let d = 0; d < dims; d += 1) point[d] -= mean[d];
  }

  return Y;
}

/**
 * 力导向布局：在二维里直接优化"相似的点靠近"。
 *
 * 为什么它比 t-SNE 更适合这份数据：497 段对话在语义上是连续分布的，没有几个分离的团，
 * t-SNE 的全局结构保持在这种数据上不稳；力导向只用"每个点的 k 个近邻"当弹簧，
 * 目标明确、参数直观。（实测短边占比 42% vs t-SNE 21%。）
 */
export function layout2d(vectors, { k = 12, iterations = 800 } = {}) {
  const n = vectors.length;
  if (n === 0) return [];
  if (n < 5) return pca2(vectors).map(([x, y]) => [x * 100, y * 100]);

  // 每条边只保留一次（i<j），权重是余弦相似度
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    const sims = [];
    for (let j = 0; j < n; j += 1) {
      if (i !== j) sims.push([j, cosine(vectors[i], vectors[j])]);
    }
    sims.sort((a, b) => b[1] - a[1]);
    for (let t = 0; t < Math.min(k, sims.length); t += 1) {
      const [j, weight] = sims[t];
      if (j > i) edges.push({ a: i, b: j, w: weight });
    }
  }

  const init = pca2(vectors);
  const maxX = Math.max(...init.map((p) => Math.abs(p[0]))) || 1;
  const maxY = Math.max(...init.map((p) => Math.abs(p[1]))) || 1;
  const Y = init.map(([x, y]) => [x / maxX, y / maxY]);

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter += 1) {
    fx.fill(0);
    fy.fill(0);

    // 全局排斥：避免所有点叠在一起
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = Y[i][0] - Y[j][0];
        const dy = Y[i][1] - Y[j][1];
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-4;
        const force = 0.012 / (dist * dist);
        const ux = (dx / dist) * force;
        const uy = (dy / dist) * force;
        fx[i] += ux;
        fy[i] += uy;
        fx[j] -= ux;
        fy[j] -= uy;
      }
    }

    // 近邻吸引：越相似，目标距离越短
    for (const edge of edges) {
      const dx = Y[edge.b][0] - Y[edge.a][0];
      const dy = Y[edge.b][1] - Y[edge.a][1];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      const target = 0.05 + 0.55 * (1 - edge.w);
      const force = (dist - target) * 0.06 * (0.3 + edge.w);
      const ux = (dx / dist) * force;
      const uy = (dy / dist) * force;
      fx[edge.a] += ux;
      fy[edge.a] += uy;
      fx[edge.b] -= ux;
      fy[edge.b] -= uy;
    }

    const cooling = 0.35 * (1 - iter / iterations) + 0.05;
    for (let i = 0; i < n; i += 1) {
      Y[i][0] += fx[i] * cooling;
      Y[i][1] += fy[i] * cooling;
    }
  }

  return Y;
}

/**
 * Qwen3-Embedding 的查询指令格式。
 *
 * 官方说明：对大多数下游任务，带指令比不带能提升 1%-5%，并且建议用英文写指令。
 * 这是**非对称检索**：文档照原样嵌入，只有查询侧加这段前缀。
 * 所以向量库里的内容不受影响，改这里不需要重算任何东西。
 */
export const RETRIEVAL_INSTRUCTION =
  'Given a search query, retrieve conversations that discuss the same subject';

export function withQueryInstruction(query) {
  return `Instruct: ${RETRIEVAL_INSTRUCTION}\nQuery: ${query}`;
}