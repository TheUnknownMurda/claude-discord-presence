'use strict';

/**
 * The tiny template language used by every text field in `presence` config.
 *
 * A field may contain `{placeholders}` — e.g. "Coding {project} · {today}" —
 * which are substituted at build time. Values are resolved LAZILY through a
 * callback so a template that never mentions `{today}` never reads stats.json.
 *
 * Two conveniences keep the output honest when data is missing:
 *
 *   - A placeholder may carry a unit that agrees in number with it:
 *     "{messages:prompt|prompts}" renders "1 prompt" or "12 prompts".
 *
 *   - Text is made of SEGMENTS separated by " · ", " | ", " – ", " — " or
 *     " - ". A segment whose placeholders all come up empty disappears as a
 *     whole, words included, so "{model} · {messages:prompt|prompts} sent"
 *     reads "Opus 4.8" outside a session rather than "Opus 4.8 · sent".
 *     Leftover punctuation is tidied up as well.
 */

// {name} or {name:singular|plural}
const PLACEHOLDER_RE = /\{([a-z0-9_]+)(?::([^{}|]*)\|([^{}|]*))?\}/gi;
// Same pattern without /g: `test()` on a global regex is stateful (lastIndex).
const HAS_PLACEHOLDER_RE = /\{[a-z0-9_]+(?::[^{}|]*\|[^{}|]*)?\}/i;

// Separators we clean up when a placeholder around them resolves to nothing.
const SEP = '·|–—-';
// A separator that splits the text into segments: surrounded by whitespace,
// so a hyphen inside a word ("pair-programming") never counts.
const SEGMENT_SPLIT_RE = /(\s+[·|–—-]\s+)/;

/** Removes dangling separators and double spaces left by empty placeholders. */
function tidy(text) {
  return String(text)
    .replace(new RegExp(`\\s*[${SEP}]\\s*(?=[${SEP}])`, 'g'), '') // "· ·" → "·"
    .replace(new RegExp(`^\\s*[${SEP}]\\s*`), '') // leading separator
    .replace(new RegExp(`\\s*[${SEP}]\\s*$`), '') // trailing separator
    .replace(/\(\s*\)|\[\s*\]/g, '') // emptied brackets
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Every placeholder name used in `template`, lowercased and de-duplicated. */
function placeholders(template) {
  if (template == null) return [];
  const found = new Set();
  for (const m of String(template).matchAll(PLACEHOLDER_RE)) found.add(m[1].toLowerCase());
  return [...found];
}

/** True when `template` contains at least one placeholder. */
function hasPlaceholders(template) {
  return placeholders(template).length > 0;
}

/**
 * @param {string|undefined|null} template
 * @param {(name: string) => any} resolve  called once per DISTINCT placeholder
 * @returns {string|undefined|null} the rendered text (input passed through when nullish)
 */
function render(template, resolve) {
  if (template == null) return template;
  const str = String(template);
  if (!HAS_PLACEHOLDER_RE.test(str)) return str;

  const cache = new Map();
  const lookup = (name) => {
    if (!cache.has(name)) {
      let value;
      try {
        value = typeof resolve === 'function' ? resolve(name) : undefined;
      } catch (_) {
        value = undefined; // a broken resolver must never break the presence
      }
      cache.set(name, value == null || value === '' ? '' : String(value));
    }
    return cache.get(name);
  };

  // Render segment by segment; drop a segment whose placeholders are all empty.
  const parts = str.split(SEGMENT_SPLIT_RE);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) { out.push(part); continue; } // a separator
    let used = 0;
    let filled = 0;
    const rendered = part.replace(PLACEHOLDER_RE, (_, name, singular, plural) => {
      used++;
      const value = lookup(name.toLowerCase());
      if (value === '') return '';
      filled++;
      if (plural === undefined) return value;
      const n = Number(value);
      const unit = Number.isFinite(n) && Math.abs(n) === 1 ? singular : plural;
      return unit ? `${value} ${unit}` : value;
    });
    out.push(used > 0 && filled === 0 ? '' : rendered);
  }
  return tidy(out.join(''));
}

module.exports = { render, placeholders, hasPlaceholders, tidy };
