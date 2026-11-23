const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

export function slugify(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let result = '', pendingDash = false;
  for (const c of plain) {
    let kept;
    if (c >= 'A' && c <= 'Z') kept = c.toLowerCase();
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) kept = c;
    if (kept === undefined) { pendingDash = result.length !== 0; continue; }
    if (pendingDash) result += '-';
    result += kept;
    pendingDash = false;
  }
  result = result.slice(0, 64).replace(/-+$/, '');
  return result || 'untitled';
}

export function uniqueSlug(slug, taken) {
  let result = slug;
  for (let n = 2; taken.has(result); n++) result = `${slug}-${n}`;
  taken.add(result);
  return result;
}

function daysIn(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function stringValue(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let value = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        value += next;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else value += c;
    }
    return { value };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const value = stringValue(raw);
    return 'error' in value ? { error: `key "${key}": ${value.error}` } : value;
  }
  if (key === 'date') {
    const match = DATE.exec(raw);
    const year = match ? Number(match[1]) : 0;
    const month = match ? Number(match[2]) : 0;
    const day = match ? Number(match[3]) : 0;
    return match && year >= 1970 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
      ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((tag) => tag.trim());
    return tags.some((tag) => tag === '' || !TAG.test(tag))
      ? { error: 'key "tags": an empty tag, or one holding " [ or ]' } : { value: tags };
  }
  if (key === 'draft') return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  if (key === 'layout') return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  if (key === 'slug') return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  return { error: `unknown key "${key}"` };
}

export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  if (end < 0) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const match = LINE.exec(line);
    if (!match) return { error: `line ${i + 1} is not "key: value"` };
    const key = match[1];
    const raw = (match[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const value = valueOf(key, raw);
    if ('error' in value) return value;
    data[key] = value.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(end + 1).join('\n') };
}

function headingOf(line) {
  const match = HEADING.exec(line);
  return match === null || match[2] === '' ? null : { depth: match[1].length, text: match[2] };
}
function trimLine(line) { return line.replace(/^[ \t]+|[ \t]+$/g, ''); }
function endsParagraph(line) { return BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line); }

function lex(src) {
  const lines = src.split('\n'), tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) { i++; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang: fence[1], lines: body }); continue;
    }
    const heading = headingOf(line);
    if (heading) { tokens.push({ type: 'heading', depth: heading.depth, text: heading.text }); i++; continue; }
    if (HR.test(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((x) => x !== '') }); continue;
    }
    const bullet = BULLET.exec(line), ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet || ordered) {
      const orderedList = ordered !== null, marker = orderedList ? ORDERED : BULLET, items = [];
      while (i < lines.length) {
        const match = marker.exec(lines[i]);
        if (match) { items.push([trimLine(orderedList ? match[2] : match[1])]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      tokens.push({ type: 'list', ordered: orderedList, start: orderedList ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) }); continue;
    }
    const body = [trimLine(line)]; i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

function findUnescaped(text, needle, from) {
  for (let i = from; i <= text.length - needle.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) { i++; continue; }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}
function findSingleStar(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) { i++; continue; }
    if (text[i] !== '*') continue;
    if (text[i + 1] === '*') { i++; continue; }
    return i;
  }
  return -1;
}
function inline(text, env) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) { out += escapeHtml(text[i + 1]); i += 2; continue; }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`; i = end + 1; } else { out += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (text[i + 1] === '*') {
        const end = findUnescaped(text, '**', i + 2);
        if (end > i + 2) { out += `<strong>${inline(text.slice(i + 2, end), env)}</strong>`; i = end + 2; } else { out += '**'; i += 2; }
      } else {
        const end = findSingleStar(text, i + 1);
        if (end > i + 1) { out += `<em>${inline(text.slice(i + 1, end), env)}</em>`; i = end + 1; } else { out += '*'; i++; }
      }
      continue;
    }
    if (c === '[') {
      const close = findUnescaped(text, ']', i + 1);
      const end = close !== -1 && text[close + 1] === '(' ? text.indexOf(')', close + 2) : -1;
      const target = end === -1 ? '' : text.slice(close + 2, end);
      if (target !== '' && !/\s/.test(target)) { out += `<a href="${escapeHtml(env.link(target))}">${inline(text.slice(i + 1, close), env)}</a>`; i = end + 1; continue; }
    }
    out += escapeHtml(c); i++;
  }
  return out;
}

export function renderMarkdown(src, env) {
  const ids = new Set(), blocks = [], toc = [];
  let excerpt = null;
  for (const token of lex(src)) {
    if (token.type === 'heading') {
      const id = uniqueSlug(slugify(token.text), ids), html = inline(token.text, env);
      blocks.push(`<h${token.depth} id="${id}">${html}</h${token.depth}>`);
      if (token.depth === 2 || token.depth === 3) toc.push({ level: token.depth, id, html });
    } else if (token.type === 'code') {
      const cls = token.lang === '' ? '' : ` class="language-${escapeHtml(token.lang)}"`;
      blocks.push(`<pre><code${cls}>${token.lines.map((line) => `${escapeHtml(line)}\n`).join('')}</code></pre>`);
    } else if (token.type === 'hr') blocks.push('<hr>');
    else if (token.type === 'blockquote') blocks.push(token.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(token.lines.join('\n'), env)}</p>\n</blockquote>`);
    else if (token.type === 'list') {
      const tag = token.ordered ? 'ol' : 'ul';
      const open = token.ordered && token.start !== 1 ? `<ol start="${token.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${token.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
    } else {
      const html = inline(token.text, env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  return { html: blocks.map((block) => `${block}\n`).join(''), toc, excerpt: excerpt ?? '' };
}
