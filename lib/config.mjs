/**
 * 本地配置：端点、Key、常用模型。
 *
 * 存在 memory/config.json（已在 .gitignore 里）。注意 Key 是明文落盘的——
 * 这台机器上的个人工具，权衡后选择方便；不想落盘就别在页面上保存，改用环境变量。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  embedModel: '',
  chatModel: '',
};

export function configPath(outDir = 'memory') {
  return path.join(outDir, 'config.json');
}

export function loadConfig(outDir = 'memory') {
  const file = configPath(outDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(outDir, patch) {
  const file = configPath(outDir);
  const merged = { ...loadConfig(outDir) };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined && patch[key] !== null) merged[key] = String(patch[key]).trim();
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return merged;
}

/** 优先级：命令行 > 环境变量 > 配置文件。 */
export function resolveRuntime({ outDir = 'memory', flagBaseUrl, flagApiKey } = {}) {
  const config = loadConfig(outDir);
  return {
    config,
    baseUrl: flagBaseUrl || process.env.DS_BASE_URL || config.baseUrl || '',
    apiKey: flagApiKey || process.env.DS_API_KEY || process.env.OPENAI_API_KEY || config.apiKey || '',
  };
}
