// Máddu cockpit — Docs route view (the in-cockpit manual reader).
//
// Extracted from cockpit.js (v1.48.0) as the "docs" cluster of Phase 1 — a
// single but substantial renderer: it fetches the docs index, renders markdown
// pages, builds an auto TOC + backlinks, intercepts in-article links, and keeps
// a route-local `hashchange` listener that self-removes the moment the operator
// navigates away from #/docs. It is a PURE move: only leaves (cockpit-util),
// the chart widgets (donut/statusGrid), the markdown renderer, and route
// metadata — no shell-only helpers — so it needs no ctx and imports nothing back
// from cockpit.js (no circular dependency).

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { statusGrid, donut } from './cockpit-widgets.js';
import { renderMarkdown } from './cockpit-markdown.js';
import { ROUTE_META } from './cockpit-route-meta.js';

export function renderDocs() {
  const root = el('div', { class: 'view' });

  // Summary widget — counts + section breakdown
  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading docs index…'));
  root.appendChild(panel('Manual', `${ROUTE_META.docs.description}  ·  press ? to open from any route`, summaryMount));

  const layout = el('div', { class: 'docs-layout' });
  const sidebar = el('aside', { class: 'docs-sidebar' });
  const main = el('section', { class: 'docs-main' });
  sidebar.appendChild(loading('Fetching docs…'));
  main.appendChild(loading('Pick a page on the left.'));
  layout.appendChild(sidebar);
  layout.appendChild(main);
  root.appendChild(layout);

  let current = null;
  let backlinks = {}; // { targetSlug: [{ from, fromTitle, anchor, linkText }] }

  function getRequestedSlug() {
    const m = location.hash.match(/[?&]p=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function getRequestedAnchor() {
    const m = location.hash.match(/[?&]a=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setSlugInHash(slug, anchor) {
    const base = '#/docs';
    const parts = [];
    if (slug) parts.push(`p=${encodeURIComponent(slug)}`);
    if (anchor) parts.push(`a=${encodeURIComponent(anchor)}`);
    location.hash = parts.length ? `${base}?${parts.join('&')}` : base;
  }

  function slugify(text) {
    return String(text).toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 64);
  }

  function buildTOC(article) {
    const headings = Array.from(article.querySelectorAll('h2, h3'));
    if (headings.length < 2) return null;
    const nav = el('nav', { class: 'docs-toc' });
    nav.appendChild(el('div', { class: 'docs-toc-title' }, 'Contents'));
    const list = el('ol', { class: 'docs-toc-list' });
    for (const h of headings) {
      const link = el('a', { href: '#', class: 'docs-toc-link docs-toc-' + h.tagName.toLowerCase() }, h.textContent || '');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (h.id) setSlugInHash(current, h.id);
      });
      list.appendChild(el('li', {}, link));
    }
    nav.appendChild(list);
    return nav;
  }

  function buildBacklinks(slug) {
    const refs = backlinks[slug] || [];
    if (refs.length === 0) return null;
    // De-dupe by from+anchor.
    const seen = new Set();
    const uniq = [];
    for (const r of refs) {
      const key = r.from + '#' + (r.anchor || '');
      if (seen.has(key)) continue;
      seen.add(key); uniq.push(r);
    }
    const wrap = el('aside', { class: 'docs-backlinks' });
    wrap.appendChild(el('div', { class: 'docs-backlinks-title' }, `Referenced by ${uniq.length} page${uniq.length === 1 ? '' : 's'}`));
    const list = el('ul', { class: 'docs-backlinks-list' });
    for (const r of uniq) {
      const a = el('a', { href: '#', class: 'docs-backlinks-link' }, r.fromTitle);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        setSlugInHash(r.from, r.anchor || null);
      });
      const item = el('li', {}, [
        a,
        r.linkText ? el('span', { class: 'docs-backlinks-context' }, ` — "${r.linkText}"`) : null
      ]);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
  }

  async function loadDoc(slug, anchor) {
    main.innerHTML = '';
    main.appendChild(loading('Loading…'));
    try {
      const r = await fetch(`/bridge/docs/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      if (!r.ok) { main.innerHTML = ''; main.appendChild(placeholder('Not found', `No doc named ${slug}`)); return; }
      const doc = await r.json();
      current = doc.slug;
      main.innerHTML = '';
      const article = el('article', { class: 'docs-article' });
      article.innerHTML = renderMarkdown(doc.body);

      // Inject heading anchor IDs (h2/h3) + a hover "¶" link for each.
      for (const h of article.querySelectorAll('h2, h3, h4')) {
        if (!h.id) h.id = slugify(h.textContent || '');
        // small anchor permalink, click to copy hash to URL
        const a = el('a', { class: 'docs-anchor', href: `#/docs?p=${encodeURIComponent(current)}&a=${encodeURIComponent(h.id)}`, title: 'Link to this section' }, '¶');
        a.addEventListener('click', (e) => {
          e.preventDefault();
          setSlugInHash(current, h.id);
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        h.appendChild(a);
      }

      // Build TOC (auto from h2/h3) and prepend.
      const toc = buildTOC(article);
      if (toc) main.appendChild(toc);

      main.appendChild(article);

      // Backlinks footer.
      const bl = buildBacklinks(current);
      if (bl) main.appendChild(bl);

      // Intercept all in-article links:
      //   • `name.md`            → switch page
      //   • `name.md#anchor`     → switch page + scroll
      //   • `#anchor`            → smooth-scroll within current doc
      //   • absolute / http(s)   → leave alone
      article.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (a.classList.contains('docs-anchor')) return; // handled above
        // in-doc anchor
        let m = href.match(/^#([a-zA-Z0-9_\-]+)$/);
        if (m) {
          e.preventDefault();
          const target = article.querySelector('#' + CSS.escape(m[1]));
          if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); setSlugInHash(current, m[1]); }
          return;
        }
        // cross-doc with optional anchor
        m = href.match(/^\.?\/?([a-zA-Z0-9_\-]+)\.md(?:#([a-zA-Z0-9_\-]+))?$/);
        if (m) { e.preventDefault(); setSlugInHash(m[1], m[2] || null); }
      });

      // Highlight active sidebar entry.
      sidebar.querySelectorAll('a.docs-link').forEach((a) => {
        if (a.dataset.slug === current) a.classList.add('active');
        else a.classList.remove('active');
      });

      // Scroll to requested anchor (or top).
      if (anchor) {
        const target = article.querySelector('#' + CSS.escape(anchor));
        if (target) { setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }
      } else {
        window.scrollTo?.({ top: 0 });
      }
    } catch (err) {
      main.innerHTML = '';
      main.appendChild(placeholder('Offline', String(err)));
    }
  }

  (async () => {
    try {
      const r = await fetch('/bridge/docs', { cache: 'no-store' });
      if (!r.ok) {
        sidebar.innerHTML = ''; sidebar.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        summaryMount.innerHTML = ''; summaryMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        return;
      }
      const respBody = await r.json();
      const { docs } = respBody;
      backlinks = respBody.backlinks || {};
      sidebar.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!docs.length) {
        sidebar.appendChild(placeholder('No docs', 'No markdown files found under docs/.'));
        summaryMount.appendChild(placeholder('No docs', 'No markdown files found under docs/.'));
        return;
      }

      // Group by leading digits → "section" (e.g. 00-, 01-, …). Files without
      // a numeric prefix go into "Reference".
      const sections = { 'Manual': 0, 'Reference': 0, 'Research': 0 };
      let numbered = 0, aliases = 0;
      for (const d of docs) {
        if (/^research\//.test(d.file)) sections.Research++;
        else if (/^\d{2}-/.test(d.file)) { sections.Manual++; numbered++; }
        else { sections.Reference++; }
        if (/(see|alias|redirect)/i.test(d.title || '')) aliases++;
      }
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'Manual',    value: sections.Manual,    tone: 'accent' },
        { label: 'Reference', value: sections.Reference, tone: 'blue' },
        { label: 'Research',  value: sections.Research,  tone: 'neutral' }
      ], { centerLabel: docs.length === 1 ? 'doc' : 'docs' }));
      summary.appendChild(statusGrid([
        { value: docs.length, label: 'Pages',         tone: 'accent' },
        { value: numbered,    label: 'Numbered',      tone: 'blue' },
        { value: sections.Reference, label: 'Reference', tone: 'ok' },
        { value: aliases,     label: 'Aliases',       tone: 'neutral' }
      ]));
      summaryMount.appendChild(summary);
      const hint = el('div', { style: 'margin-top:10px;font-size:12px;color:var(--m-fg-3);font-family:var(--m-font-mono);' },
        `served from /bridge/docs  ·  raw files under <repoRoot>/docs/ or <runtime>/../docs/`);
      summaryMount.appendChild(hint);

      const nav = el('nav', { class: 'docs-nav' });
      for (const d of docs) {
        const a = el('a', { class: 'docs-link', href: '#', 'data-slug': d.slug });
        a.textContent = d.title || d.slug;
        a.addEventListener('click', (e) => { e.preventDefault(); setSlugInHash(d.slug); });
        nav.appendChild(a);
      }
      sidebar.appendChild(nav);
      const requested = getRequestedSlug();
      const requestedAnchor = getRequestedAnchor();
      const initial = requested && docs.find((d) => d.slug === requested) ? requested : docs[0].slug;
      loadDoc(initial, requestedAnchor);
    } catch (err) {
      sidebar.innerHTML = '';
      summaryMount.innerHTML = '';
      sidebar.appendChild(placeholder('Offline', String(err)));
      summaryMount.appendChild(placeholder('Offline', String(err)));
    }
  })();

  // React to hash-query changes while staying on #/docs.
  const onHashChange = () => {
    if (!location.hash.startsWith('#/docs')) { window.removeEventListener('hashchange', onHashChange); return; }
    const slug = getRequestedSlug();
    const anchor = getRequestedAnchor();
    if (slug && slug !== current) {
      loadDoc(slug, anchor);
    } else if (anchor && current) {
      // Same doc, new anchor — just scroll.
      const article = main.querySelector('.docs-article');
      const target = article && article.querySelector('#' + CSS.escape(anchor));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  window.addEventListener('hashchange', onHashChange);

  return root;
}
