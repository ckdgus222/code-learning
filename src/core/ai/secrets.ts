// Common, high-precision secret shapes are masked before code leaves the app for an AI provider.
// This lowers the chance of sending a secret; it does not find every secret, and the screen says so.
// Masked text is only ever sent, never used for positions: answers cite evidence IDs, and the app
// finds ranges in the original source.

export const SECRET_MASK = '[MASKED_SECRET]';
export const PRIVATE_KEY_MASK = '[MASKED_PRIVATE_KEY]';

// An unclosed block is masked to the end of the text.
const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const tokens = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ID
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic and similar
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
// This runs in the main process on files up to 32 KiB, so every pattern that can fail after a long
// run starts only at the beginning of that run (the lookbehinds); otherwise a crafted line could take
// time quadratic in its length and freeze the app.
// The password part of `scheme://user:password@host`.
const connection = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)(@)/gi;
// The key name is matched as one plain identifier and checked for a secret word separately.
const secretWord = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key/i;
// `password = "hunter22"`, `apiKey: 'abc…'`, `"client_secret": "…"`: only the string's content is masked.
// A string ends at its own quote; other quote kinds, escapes and backslash line continuations
// (`\` then LF or CRLF) inside it are content.
const quoted = /((?<![\w.-])["']?([\w.-]+)["']?\s*[:=]\s*)("(?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*"|'(?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*'|`(?:[^`\\]|\\[\s\S])*`)/g;
// A whole config line such as `password: hunter2` or `TOKEN=abc123`. A value with spaces, quotes,
// brackets or `;`/`,` is code (`token = getToken();`) and is left alone.
const configLine = /^([ \t]*["']?([\w.-]+)["']?[ \t]*[:=][ \t]*)([^\s'"`()[\]{};,]+)[ \t]*\r?$/gm;

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0;
  const mask = (replacement: string) => { count++; return replacement; };
  // Keep the same number of lines so line positions the model sees still match the source.
  let result = text.replace(privateKey, block => mask(PRIVATE_KEY_MASK + '\n'.repeat(block.split('\n').length - 1)));
  for (const pattern of tokens) result = result.replace(pattern, () => mask(SECRET_MASK));
  result = result.replace(connection, (_match, before: string, password: string, at: string) =>
    password === SECRET_MASK ? before + password + at : mask(before + SECRET_MASK + at));
  result = result.replace(quoted, (match: string, before: string, name: string, literal: string) => {
    // Values of 3 characters or fewer are left as they are; line breaks inside the string are kept.
    if (!secretWord.test(name) || literal.length - 2 < 4) return match;
    const replaced = before + literal[0] + SECRET_MASK + '\n'.repeat(literal.split('\n').length - 1) + literal[0];
    // A value an earlier rule already masked (a token in `token = "…"`) is still one secret.
    return literal.includes(SECRET_MASK) || literal.includes(PRIVATE_KEY_MASK) ? replaced : mask(replaced);
  });
  result = result.replace(configLine, (match: string, before: string, name: string) =>
    secretWord.test(name) ? mask(before + SECRET_MASK + (match.endsWith('\r') ? '\r' : '')) : match);
  return { text: result, count };
}
