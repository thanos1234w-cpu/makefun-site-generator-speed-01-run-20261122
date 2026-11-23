import { parseFrontMatter, renderMarkdown, slugify, uniqueSlug, longDate, escapeHtml } from './content.js';
import { TemplateError, parseTemplate, renderNodes } from './templates.js';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const directory = name => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
const adjacent = p => p ? { title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.data.date === undefined ? '' : longDate(p.data.date) } : null;

function relativePath(dir, relative) {
  const parts = dir ? dir.split('/') : [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map(), warnings = [], broken = new Set();
  for (const name of Object.keys(input.templates).sort(compare)) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      warnings.push(error.message);
    }
  }
  const files = [...input.files].sort((a, b) => compare(a.path, b.path));
  const statics = [], candidates = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) candidates.push({path:f.path, text:f.content.replace(/\r\n?/g, '\n')});
    else statics.push(f);
  }
  const sources = [], bySource = new Map(), taken = new Map();
  for (const c of candidates) {
    const fm = parseFrontMatter(c.text);
    if ('error' in fm) { warnings.push(`refused ${c.path}: ${fm.error}`); continue; }
    const post = c.path.startsWith('posts/');
    const reserved = c.path.startsWith('tags/') ? 'tags' : c.path.startsWith('page/') ? 'page' : null;
    if (reserved) { warnings.push(`refused ${c.path}: ${reserved}/ is the generator's own`); continue; }
    if (post && !Object.hasOwn(fm.data, 'date')) { warnings.push(`refused ${c.path}: a post needs a date`); continue; }
    const layout = fm.data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) { warnings.push(`refused ${c.path}: layout "${layout}" is no template that parses`); continue; }
    if (fm.data.draft === true) { warnings.push(`draft ${c.path}`); continue; }
    const dir = post ? 'posts' : directory(c.path);
    if (!taken.has(dir)) taken.set(dir, new Set(dir ? [] : ['posts','tags','page']));
    const slug = uniqueSlug(fm.data.slug ?? slugify(fm.data.title), taken.get(dir));
    const outDir = dir ? `${dir}/${slug}` : slug;
    const s = {path:c.path, data:fm.data, body:fm.body, post, layout, slug, outDir, url:`${base}/${outDir}/`};
    sources.push(s); bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map(f => f.path));
  for (const s of sources) {
    const env = {link(target) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash < 0 ? target : target.slice(0, hash);
      const fragment = hash < 0 ? '' : target.slice(hash);
      const path = rel ? relativePath(directory(s.path), rel) : null;
      const dest = bySource.get(path);
      if (dest) return dest.url + fragment;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${fragment}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    }};
    const result = renderMarkdown(s.body, env);
    s.html = result.html; s.toc = result.toc; s.excerpt = result.excerpt;
  }
  const posts = sources.filter(s => s.post).sort((a, b) => compare(b.data.date, a.data.date) || compare(a.slug, b.slug));
  for (let i = 0; i < posts.length; i++) { posts[i].newer = posts[i-1] ?? null; posts[i].older = posts[i+1] ?? null; }
  const tagsBySlug = new Map();
  const uniqueTags = s => {
    const seen = new Set(), values = [];
    for (const name of s.data.tags ?? []) { const slug = slugify(name); if (!seen.has(slug)) { seen.add(slug); values.push([name,slug]); } }
    return values;
  };
  for (const post of posts) {
    post.tagRefs = [];
    for (const [name,slug] of uniqueTags(post)) {
      if (!tagsBySlug.has(slug)) tagsBySlug.set(slug, {name,slug,url:`${base}/tags/${slug}/`,posts:[]});
      const t = tagsBySlug.get(slug); t.posts.push(post); post.tagRefs.push(t);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = uniqueTags(s).map(([name,slug]) => tagsBySlug.get(slug) ?? {name,slug,url:'',posts:[]});
  const tags = [...tagsBySlug.values()].sort((a,b) => b.posts.length-a.posts.length || compare(a.slug,b.slug));
  function card(s) {
    return { title:s.data.title, url:s.url, date:s.data.date ?? '', date_long:s.data.date === undefined ? '' : longDate(s.data.date), summary:s.data.summary ?? '', excerpt:s.excerpt, reading_minutes:Math.max(1, Math.ceil((s.body.match(/\S+/g)?.length ?? 0)/200)), tags:s.tagRefs.map(t => ({name:t.name,slug:t.slug,url:t.url})) };
  }
  const cards = new Map(posts.map(p => [p,card(p)]));
  const common = {site:{title:input.site.title,base_url:base}, tags:tags.map(t => ({name:t.name,slug:t.slug,url:t.url,count:t.posts.length})), recent:posts.slice(0,input.site.recent).map(p=>cards.get(p))};
  const context = {templates, escape:escapeHtml};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, {vars:{...common,...vars},parent:null}, context, 0);
  };
  const output = {};
  for (const s of sources) {
    const page = {...card(s), slug:s.slug, content:s.html, toc:s.toc.map(({level,id,html})=>({level,id,html})), newer:adjacent(s.newer), older:adjacent(s.older), is_post:s.post};
    output[`${s.outDir}/index.html`] = render(s.layout, {page});
  }
  const count = Math.max(1, Math.ceil(posts.length/input.site.per_page));
  const indexUrl = i => i === 1 ? `${base}/` : `${base}/page/${i}/`;
  for (let i=1;i<=count;i++) {
    const html = render('index', {posts:posts.slice((i-1)*input.site.per_page,i*input.site.per_page).map(p=>cards.get(p)),pager:{number:i,total:count,url:indexUrl(i),newer_url:i===1?'':indexUrl(i-1),older_url:i===count?'':indexUrl(i+1)}});
    if (html !== null) output[i===1?'index.html':`page/${i}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {tag:{name:t.name,slug:t.slug,url:t.url,count:t.posts.length,posts:t.posts.map(p=>cards.get(p))}});
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagIndex = render('tags', {});
  if (tagIndex !== null) output['tags/index.html'] = tagIndex;
  for (const f of statics) {
    if (Object.hasOwn(output,f.path)) warnings.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...warnings,...broken].sort(compare);
  lines.push(`built ${sources.length-posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
