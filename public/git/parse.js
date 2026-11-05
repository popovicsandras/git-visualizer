// Command-line parsing helpers: quote-aware tokenizer and a small option parser.

export class GitError extends Error {
  constructor(lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    super(arr.map((l) => (typeof l === 'string' ? l : l.text)).join('\n'));
    this.lines = arr;
  }
}

/** Split a command line into tokens, honouring single and double quotes. */
export function tokenize(input) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) throw new GitError(`error: unterminated ${quote} quote`);
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * Parse options according to `spec`:
 *   { '-m': { key: 'message', value: true, multi: true }, '--force': { key: 'force' } }
 * Supports combined short flags (-am "msg"), attached values (-mmsg) and --opt=value.
 */
export function parseOpts(args, spec) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      pos.push(arg);
      continue;
    }
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    let parts = [arg];
    if (!spec[arg] && !arg.startsWith('--') && arg.length > 2) {
      parts = [...arg.slice(1)].map((c) => '-' + c);
    }
    for (let j = 0; j < parts.length; j++) {
      const name = parts[j];
      const s = spec[name];
      if (!s) {
        const kind = name.startsWith('--') ? 'option' : 'switch';
        throw new GitError(`error: unknown ${kind} \`${name.replace(/^-+/, '')}'`);
      }
      if (!s.value) {
        opts[s.key] = true;
        continue;
      }
      let v = inline;
      if (v === undefined) {
        if (j < parts.length - 1) {
          v = parts.slice(j + 1).map((p) => p.slice(1)).join('');
          j = parts.length;
        } else {
          v = args[++i];
        }
      }
      if (v === undefined) throw new GitError(`error: option \`${name.replace(/^-+/, '')}' requires a value`);
      if (s.multi) (opts[s.key] ??= []).push(v);
      else opts[s.key] = v;
    }
  }
  return { opts, pos };
}
