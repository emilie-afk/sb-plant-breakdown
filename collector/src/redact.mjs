// Keeps secrets out of logs and run records (same approach as sb-gross-profit).
const secrets = new Set();
export function registerSecret(s) { if (typeof s === 'string' && s.length >= 4) secrets.add(s); }
export function scrub(text) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    for (const form of [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)]) out = out.split(form).join('<redacted>');
  }
  return out;
}
export function containsSecret(text) {
  const t = String(text == null ? '' : text);
  for (const s of secrets) if (t.includes(s)) return true;
  return false;
}
// First line only, URLs and emails masked, capped. Error text from browsers can
// echo page content; none of it belongs in a log.
export function safeError(e) {
  const first = String((e && e.message) || e || 'error').split('\n')[0];
  return scrub(first)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .slice(0, 300);
}
export function _resetForTests() { secrets.clear(); }
