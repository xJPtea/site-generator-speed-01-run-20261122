// Fast drop-in for makefun-site 1.0.0.
//
// Written from scratch in this session. It returns exactly the output tree
// makefun-site 1.0.0's build returns for the same input: the same pages, index
// and tag pages, static files and build report, byte for byte. The speed comes
// from doing the same work with less allocation: batched inline rendering
// (never one escape call per character), a single-pass Markdown scan with no
// token objects, front matter read by offsets instead of split-and-join, and a
// template renderer that walks a scope stack instead of a linked scope chain.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---------------------------------------------------------------- slugs and dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** A YYYY-MM-DD date in words, memoised in `cache` (one cache per build). */
function longDateCached(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const out = longDate(date);
  cache.set(date, out);
  return out;
}

/** Whether `s` holds only ASCII characters (NFKD leaves ASCII untouched). */
function isAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

/** The slug rule over `plain` (already NFKD, combining marks already dropped). */
function slugCore(plain) {
  // Runs of characters other than a-z and 0-9 become one -, none at either
  // end; cut to 64 characters, a - left at the cut dropped.
  let out = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (out[0] === '-') out = out.slice(1);
  if (out[out.length - 1] === '-') out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out[out.length - 1] === '-') out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised in `cache` (one cache per build). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = isAscii(text) ? slugCore(text) : slugCore(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FRONT_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** The number in `s` at `at` over `len` digits, or -1 when it is not digits. */
function digitsAt(s, at, len) {
  let n = 0;
  for (let k = 0; k < len; k++) {
    const c = s.charCodeAt(at + k);
    if (c < 48 || c > 57) return -1;
    n = n * 10 + (c - 48);
  }
  return n;
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31 (YYYY-MM-DD). */
function isDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  const y = digitsAt(raw, 0, 4);
  const mo = digitsAt(raw, 5, 2);
  const d = digitsAt(raw, 8, 2);
  if (y === -1 || mo === -1 || d === -1) return false;
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** Whether `raw` is a template name (a-z, 0-9 and -). */
function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single - between). */
function isSlug(raw) {
  if (raw.length === 0) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '-') {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** A quoted or bare string value, or why it is refused. */
function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line (line `num`, counted from 1 at the opening ---),
 * folded into `data`; null when fine, else the refusal reason.
 */
function fmLine(line, num, data) {
  const colon = line.indexOf(':');
  if (colon <= 0) return `line ${num} is not "key: value"`;
  const key = line.slice(0, colon);
  if (!/^[a-z_]+$/.test(key)) return `line ${num} is not "key: value"`;
  const rest = line.slice(colon + 1);
  let raw;
  if (rest === '') raw = '';
  else if (rest[0] === ' ') raw = rest.slice(1);
  else return `line ${num} is not "key: value"`;
  raw = raw.replace(/[ \t]+$/, '');
  if (!FRONT_KEYS.includes(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if (v.error !== undefined) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is sliced
 * out of the source, never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing --- line (the first line after the opening that is exactly ---).
  let lineStart = 4;
  let lineNo = 1;
  let closeStart = -1;
  let closeNo = -1;
  while (true) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(lineStart, lineEnd) === '---') {
      closeStart = lineStart;
      closeNo = lineNo;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
    lineNo++;
  }
  if (closeNo === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = 4;
  for (let ln = 1; ln < closeNo; ln++) {
    const nl = text.indexOf('\n', ls);
    const le = nl === -1 ? text.length : nl;
    const line = text.slice(ls, le);
    ls = le + 1;
    if (isBlank(line) || line[0] === '#') continue;
    const err = fmLine(line, ln + 1, data);
    if (err !== null) return { error: err };
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeEnd = closeStart + 3;
  const body = closeEnd >= text.length ? '' : text[closeEnd] === '\n' ? text.slice(closeEnd + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** A cursor over a body's lines, with one line of pushback. */
function lineCursor(src) {
  let pos = 0;
  let held;
  let hasHeld = false;
  function read() {
    if (pos > src.length) return null;
    const nl = src.indexOf('\n', pos);
    if (nl === -1) {
      const line = src.slice(pos);
      pos = src.length + 1;
      return line;
    }
    const line = src.slice(pos, nl);
    pos = nl + 1;
    return line;
  }
  return {
    next() {
      if (hasHeld) {
        hasHeld = false;
        const v = held;
        held = undefined;
        return v;
      }
      return read();
    },
    peek() {
      if (!hasHeld) {
        held = read();
        hasHeld = true;
      }
      return held;
    },
  };
}

/** Whether `line` opens a fence, and its language ('' when none) — else null. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let k = 3;
  while (k < line.length) {
    const c = line[k];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-')) break;
    k++;
  }
  for (let j = k; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return null;
  return line.slice(3, k);
}

/** Whether `line` closes a fence (three backticks, spaces or tabs after). */
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}

/** A heading line's depth and text, or null (the text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < 6 && line[n] === '#') n++;
  if (n === 0) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  let end = line.length;
  while (end > n && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let s = n;
  while (s < end && (line[s] === ' ' || line[s] === '\t')) s++;
  if (s >= end) return null;
  return { depth: n, text: line.slice(s, end) };
}

/** Whether `line` is a thematic break (--- or ***, spaces or tabs after). */
function isHr(line) {
  const p = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : 0;
  if (p === 0) return false;
  for (let j = p; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line[0];
  if (c === '`') return fenceOpen(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  return false;
}

/** A bullet list's first item text, or null. */
function bulletItem(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered list's first item: { start, text }, or null. */
function orderedItem(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then non-space). */
function isContinued(line) {
  let k = 0;
  while (line[k] === ' ') k++;
  if (k < 2 || k >= line.length) return false;
  // Non-whitespace, by JavaScript's \s (the space already failed the count above).
  return !/^\s$/.test(line[k]);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j + what.length <= s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. Plain runs between
 * special characters are copied whole, so no character is escaped one by one.
 */
function inline(s, link) {
  let out = '';
  let plain = 0;
  const re = /[\\`*\[&<>"']/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > plain) out += s.slice(plain, j);
      out += ESCAPES[c];
      plain = j + 1;
      continue;
    }
    if (c === '\\') {
      const n = s[j + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        if (j > plain) out += s.slice(plain, j);
        out += ESCAPES[n] !== undefined ? ESCAPES[n] : n;
        plain = j + 2;
        re.lastIndex = j + 2;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out += s.slice(plain, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        plain = k + 1;
        re.lastIndex = k + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out += s.slice(plain, j);
          out += `<strong>${inline(s.slice(j + 2, k), link)}</strong>`;
          plain = k + 2;
          re.lastIndex = k + 2;
        } else {
          re.lastIndex = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > plain) out += s.slice(plain, j);
          out += `<em>${inline(s.slice(j + 1, k), link)}</em>`;
          plain = k + 1;
          re.lastIndex = k + 1;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = close === -1 ? '' : s.slice(k + 2, close);
    if (target !== '' && !/\s/.test(target)) {
      if (j > plain) out += s.slice(plain, j);
      out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(j + 1, k), link)}</a>`;
      plain = close + 1;
      re.lastIndex = close + 1;
    }
  }
  if (plain < s.length) out += s.slice(plain);
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's HTML, or ""). `link` is a
 * link target's href; `cache` memoises slugs.
 */
function renderMarkdown(src, link, cache) {
  const cur = lineCursor(src);
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let line;
  while ((line = cur.next()) !== null) {
    if (isBlank(line)) continue;
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      let l;
      while ((l = cur.next()) !== null && !fenceClose(l)) body.push(l);
      let code = '';
      for (const bl of body) code += `${escapeHtml(bl)}\n`;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, cache), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      let l = line;
      while (true) {
        let t = l.slice(1);
        if (t[0] === ' ') t = t.slice(1);
        const trimmed = trimLine(t);
        if (trimmed !== '') body.push(trimmed);
        const nx = cur.peek();
        if (nx === null || nx[0] !== '>') break;
        l = cur.next();
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletItem(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [[trimLine(isOrdered ? ordered.text : bullet)]];
      while (true) {
        const nx = cur.peek();
        if (nx === null) break;
        const next = isOrdered ? orderedItem(nx) : bulletItem(nx);
        if (next !== null) {
          items.push([trimLine(isOrdered ? next.text : next)]);
          cur.next();
          continue;
        }
        if (isContinued(nx)) {
          items[items.length - 1].push(trimLine(nx));
          cur.next();
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const item of items) list += `<li>${inline(item.join('\n'), link)}</li>\n`;
      blocks.push(`${list}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    while (true) {
      const nx = cur.peek();
      if (nx === null || endsParagraph(nx)) break;
      body.push(trimLine(cur.next()));
    }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ k: 'root', body: root }];
  let body = root;
  let text = '';
  let i = 0;
  const flushText = () => {
    if (text !== '') {
      body.push({ k: 'text', s: text });
      text = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      body.push({ k: raw ? 'raw' : 'var', p: splitPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src.slice(lineStart, open)) && isSpacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 'for', name: m[1], p: splitPath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 'if', not: m[1] !== undefined, p: splitPath(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.k !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.body : parent.els !== null ? parent.els : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') body.push({ k: 'text', s: text });
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root;
}

/** The value at `path` in the scope stack: first name from the nearest scope holding it. */
function lookup(scopes, path) {
  let s = scopes.length - 1;
  while (s >= 0 && !Object.hasOwn(scopes[s], path[0])) s--;
  if (s < 0) return undefined;
  let v = scopes[s][path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number in its own digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of chunks) in the scope stack.
 * `ctx` holds the parsed templates; includes nest at most 8 deep.
 */
function renderNodes(nodes, scopes, ctx, depth, out) {
  for (const n of nodes) {
    if (n.k === 'text') {
      out.push(n.s);
      continue;
    }
    if (n.k === 'var') {
      out.push(escapeHtml(textOf(lookup(scopes, n.p))));
      continue;
    }
    if (n.k === 'raw') {
      out.push(textOf(lookup(scopes, n.p)));
      continue;
    }
    if (n.k === 'if') {
      const v = truthy(lookup(scopes, n.p));
      const branch = v !== n.not ? n.then : n.els;
      if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
      continue;
    }
    if (n.k === 'for') {
      const xs = lookup(scopes, n.p);
      if (!Array.isArray(xs)) continue;
      const vars = {};
      const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
      scopes.push(vars);
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        vars.loop = loop;
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderNodes(n.body, scopes, ctx, depth, out);
      }
      scopes.pop();
      continue;
    }
    // include
    const t = ctx.templates.get(n.name);
    if (t !== undefined && depth < 8) renderNodes(t, scopes, ctx, depth + 1, out);
  }
}

// ---------------------------------------------------------------- the build

const WORD_RE = /\S+/g;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  WORD_RE.lastIndex = 0;
  while (WORD_RE.exec(text) !== null) n++;
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const cache = new Map();
  const dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();

  // 1. Sources, in code-unit order of their paths; a .md file is a source.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Front matter, in source order; a refused source or a draft is dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.splice(0, sources.length, ...kept);

  // 3. Permalinks: each page's slug, unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, cache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, cache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: posts newest first, equal dates by slug; newer and older.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s, cache) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags !== undefined ? s.data.tags : []) {
      const slug = slugify(name, cache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p, cache)) {
      const slug = slugify(name, cache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s, cache).map((name) => {
      const slug = slugify(name, cache);
      return bySlug.get(slug) !== undefined ? bySlug.get(slug) : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page, the index pages and the tag pages, then statics.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDateCached(s.data.date, dateCache),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDateCached(s.data.date, dateCache),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of sources) {
    const c = s.post ? cards.get(s) : cardOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        title: c.title,
        url: c.url,
        date: c.date,
        date_long: c.date_long,
        summary: c.summary,
        excerpt: c.excerpt,
        reading_minutes: c.reading_minutes,
        tags: c.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer !== undefined ? s.newer : null),
        older: linkOf(s.older !== undefined ? s.older : null),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
