/** 极简命令行参数解析，两个工具共用，避免各写一份。 */

/**
 * @param {string[]} argv
 * @param {Record<string, {type: 'boolean'|'string'|'number', alias?: string, default?: any, desc?: string}>} spec
 */
export function parseArgs(argv, spec) {
  const byFlag = new Map();
  const options = {};

  for (const [name, def] of Object.entries(spec)) {
    options[name] = def.default ?? (def.type === 'boolean' ? false : null);
    byFlag.set(`--${name}`, name);
    if (def.alias) byFlag.set(`-${def.alias}`, name);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) continue;

    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const name = byFlag.get(flag);

    if (!name) throw new Error(`不认识的选项：${flag}（用 --help 看用法）`);

    const def = spec[name];
    if (def.type === 'boolean') {
      options[name] = true;
      continue;
    }

    const value = inline ?? argv[(i += 1)];
    if (value === undefined) throw new Error(`${flag} 缺少取值`);
    options[name] = def.type === 'number' ? Number(value) : value;
  }

  options.help = options.help || argv.includes('-h') || argv.includes('--help');
  return options;
}

/** 按 spec 里的 desc 渲染帮助文本。 */
export function usage(title, spec, extra = '') {
  const lines = [title, '', '选项：'];
  for (const [name, def] of Object.entries(spec)) {
    if (name === 'help') continue;
    if (!def.desc) continue;
    const flags = `--${name}${def.alias ? `, -${def.alias}` : ''}`;
    lines.push(`  ${flags.padEnd(22)}${def.desc}`);
  }
  if (extra) lines.push('', extra);
  return `${lines.join('\n')}\n`;
}
