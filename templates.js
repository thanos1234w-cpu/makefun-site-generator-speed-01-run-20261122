// Fast, dependency-free implementation of makefun-site's template dialect.

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

export class TemplateError extends Error {}

function path(name, value) {
  if (!PATH_RE.test(value)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(value)} is not a path`);
  }
  return value.split('.');
}

// Scan directly into lexical tokens. Text is accumulated in slices, avoiding
// per-character work and preserving the reference's standalone-tag behavior.
function scan(name, source) {
  const result = [];
  let textStart = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open < 0) break;
    const kind = source.charCodeAt(open + 1);
    if (kind !== 123 && kind !== 37) {
      cursor = open + 1;
      continue;
    }
    if (kind === 123) {
      if (open > textStart) result.push({ type: 0, value: source.slice(textStart, open) });
      const raw = source.charCodeAt(open + 2) === 123;
      const closeText = raw ? '}}}' : '}}';
      const close = source.indexOf(closeText, open + (raw ? 3 : 2));
      if (close < 0) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      result.push({ type: raw ? 2 : 1, value: path(name, source.slice(open + (raw ? 3 : 2), close).trim()) });
      cursor = close + closeText.length;
      textStart = cursor;
      continue;
    }

    const close = source.indexOf('%}', open + 2);
    if (close < 0) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = source.lastIndexOf('\n', open - 1) + 1;
    const nextNl = source.indexOf('\n', end);
    const lineEnd = nextNl < 0 ? source.length : nextNl;
    const standalone = /^[ \t]*$/.test(source.slice(lineStart, open)) && /^[ \t]*$/.test(source.slice(end, lineEnd));
    if (standalone) {
      if (lineStart > textStart) result.push({ type: 0, value: source.slice(textStart, lineStart) });
    } else if (open > textStart) {
      result.push({ type: 0, value: source.slice(textStart, open) });
    }
    result.push({ type: 3, value: source.slice(open + 2, close).trim() });
    cursor = standalone ? (nextNl < 0 ? source.length : nextNl + 1) : end;
    textStart = cursor;
  }
  if (textStart < source.length) result.push({ type: 0, value: source.slice(textStart) });
  return result;
}

export function parseTemplate(name, source) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const token of scan(name, source)) {
    if (token.type === 0) { if (token.value) body.push({ kind: 'text', text: token.value }); continue; }
    if (token.type === 1 || token.type === 2) { body.push({ kind: token.type === 1 ? 'var' : 'raw', path: token.value }); continue; }

    const tag = token.value;
    const top = stack[stack.length - 1];
    let match;
    if ((match = FOR_RE.exec(tag))) {
      const node = { kind: 'for', name: match[1], path: path(name, match[2]), body: [] };
      body.push(node); stack.push(node); body = node.body;
    } else if ((match = IF_RE.exec(tag))) {
      const node = { kind: 'if', not: match[1] !== undefined, path: path(name, match[2]), then: [], else: null };
      body.push(node); stack.push(node); body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = []; body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const expected = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== expected) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((match = INCLUDE_RE.exec(tag))) {
      body.push({ kind: 'include', name: match[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length !== 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, names) {
  let current = scope;
  while (current !== null && !Object.hasOwn(current.vars, names[0])) current = current.parent;
  if (current === null) return undefined;
  let value = current.vars[names[0]];
  for (let i = 1; i < names.length; i++) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, names[i])) return undefined;
    value = value[names[i]];
  }
  return value;
}

function stringify(value) {
  switch (typeof value) {
    case 'string': return value;
    case 'number': return String(value);
    case 'boolean': return value ? 'true' : 'false';
    default: return Array.isArray(value) ? value.map(stringify).join(', ') : '';
  }
}

function isTrue(value) {
  return Array.isArray(value) ? value.length !== 0 : value !== undefined && value !== null && value !== false && value !== '' && value !== 0;
}

export function renderNodes(nodes, scope, ctx, depth) {
  let output = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text': output += node.text; break;
      case 'var': output += ctx.escape(stringify(lookup(scope, node.path))); break;
      case 'raw': output += stringify(lookup(scope, node.path)); break;
      case 'if': {
        const selected = isTrue(lookup(scope, node.path)) !== node.not ? node.then : node.else;
        if (selected !== null) output += renderNodes(selected, scope, ctx, depth);
        break;
      }
      case 'for': {
        const values = lookup(scope, node.path);
        if (!Array.isArray(values)) break;
        for (let i = 0, length = values.length; i < length; i++) {
          output += renderNodes(node.body, { vars: { [node.name]: values[i], loop: { index: i + 1, first: i === 0, last: i === length - 1, length } }, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const included = ctx.templates.get(node.name);
        if (included !== undefined && depth < INCLUDE_DEPTH) output += renderNodes(included, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return output;
}
