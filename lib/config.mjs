/**
 * 本地配置：两套端点。
 *
 * 为什么要分开：对话和嵌入完全可以是不同的服务——
 * 比如 chat 跑在本地 LM Studio（http://127.0.0.1:1234），
 * 嵌入用远程 API。两者各自的地址、Key、模型名都不一样。
 *
 * 存在 memory/config.json（已在 .gitignore 里）。Key 是明文落盘的——
 * 这台机器上的个人工具，权衡后选择方便；不想落盘就用环境变量。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  chatBaseUrl: '',
  chatApiKey: '',
  chatModel: '',
  embedBaseUrl: '',
  embedApiKey: '',
  embedModel: '',
};

export function configPath(outDir = 'memory') {
  return path.join(outDir, 'config.json');
}

export function loadConfig(outDir = 'memory') {
  const file = configPath(outDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };

  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return { ...DEFAULTS };
  }

  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (parsed[key] !== undefined && parsed[key] !== null) merged[key] = String(parsed[key]);
  }

  // 兼容旧版单端点配置：{ baseUrl, apiKey, embedModel, chatModel }
  const legacyUrl = parsed.baseUrl ?? '';
  const legacyKey = parsed.apiKey ?? '';
  if (!merged.chatBaseUrl && legacyUrl) merged.chatBaseUrl = String(legacyUrl);
  if (!merged.embedBaseUrl && legacyUrl) merged.embedBaseUrl = String(legacyUrl);
  if (!merged.chatApiKey && legacyKey) merged.chatApiKey = String(legacyKey);
  if (!merged.embedApiKey && legacyKey) merged.embedApiKey = String(legacyKey);

  return merged;
}

export function saveConfig(outDir, patch) {
  const merged = { ...loadConfig(outDir) };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined && patch[key] !== null) merged[key] = String(patch[key]).trim();
  }

  const file = configPath(outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return merged;
}

/**
 * 运行时端点。优先级：命令行 > 环境变量 > 配置文件。
 * 命令行的 --base-url / --api-key 同时作用于两组（临时调试够用了）。
 */
export function resolveRuntime({ outDir = 'memory', flagBaseUrl, flagApiKey } = {}) {
  const config = loadConfig(outDir);

  const pick = (configured, envValue, flag) => flag || envValue || configured || '';

  return {
    config,
    chat: {
      baseUrl: pick(config.chatBaseUrl, process.env.DS_CHAT_BASE_URL || process.env.DS_BASE_URL, flagBaseUrl),
      apiKey: pick(config.chatApiKey, process.env.DS_CHAT_API_KEY || process.env.DS_API_KEY, flagApiKey),
      model: config.chatModel || '',
    },
    embed: {
      baseUrl: pick(config.embedBaseUrl, process.env.DS_EMBED_BASE_URL || process.env.DS_BASE_URL, flagBaseUrl),
      apiKey: pick(config.embedApiKey, process.env.DS_EMBED_API_KEY || process.env.DS_API_KEY, flagApiKey),
      model: config.embedModel || '',
    },
  };
}
