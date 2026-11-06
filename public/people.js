// Small helpers for showing people (avatars, commit authors).

/** "Ada Lovelace" -> "AL", "ada" -> "A". Counts whole characters, so emoji survive. */
export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const first = (w) => [...w][0] ?? '';
  const out = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0] ?? '?');
  return out.toLocaleUpperCase() || '?';
}
