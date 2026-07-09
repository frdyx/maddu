#!/usr/bin/env node
// cockpit-markdown (v1.42.0) — the tiny CommonMark-ish renderer extracted from
// cockpit.js. Pure string → HTML string, so no DOM stub is needed; we assert the
// generated markup directly. Regression coverage the monolith never had.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

const { renderMarkdown } = await import('../../template/maddu/cockpit/cockpit-markdown.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports renderMarkdown', typeof renderMarkdown === 'function');

ok('heading → <h1>', renderMarkdown('# Title') === '<h1>Title</h1>');
ok('h3 → <h3>', renderMarkdown('### Sub') === '<h3>Sub</h3>');
ok('paragraph wraps', renderMarkdown('hello world') === '<p>hello world</p>');
ok('bold', renderMarkdown('a **b** c') === '<p>a <strong>b</strong> c</p>');
ok('italic', renderMarkdown('a *b* c') === '<p>a <em>b</em> c</p>');
ok('inline code', renderMarkdown('use `x` now') === '<p>use <code>x</code> now</p>');
ok('link', renderMarkdown('[t](http://u)') === '<p><a href="http://u">t</a></p>');
ok('horizontal rule', renderMarkdown('---') === '<hr>');
ok('blockquote', renderMarkdown('> quoted') === '<blockquote>quoted</blockquote>');
ok('unordered list', renderMarkdown('- a\n- b') === '<ul><li>a</li><li>b</li></ul>');
ok('ordered list', renderMarkdown('1. a\n2. b') === '<ol><li>a</li><li>b</li></ol>');

const fenced = renderMarkdown('```js\nconst x=1;\n```');
ok('fenced code → pre.md-code w/ data-lang', fenced === '<pre class="md-code" data-lang="js"><code>const x=1;</code></pre>');

ok('escapes HTML', renderMarkdown('a <b> & c') === '<p>a &lt;b&gt; &amp; c</p>');

const table = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
ok('table → table.md-table', table.startsWith('<table class="md-table">') && table.includes('<th>a</th>') && table.includes('<td>1</td>'));

// Security regression boundary (audit 2026-07-09, Codex-reviewed). These lock
// the two XSS bypasses fixed in P0a — do not weaken without a security review.
ok('drops javascript: links', !/href/.test(renderMarkdown('[x](javascript:alert(1))')));
ok('drops tab-obfuscated javascript: (browsers strip tabs)',
  !/href/.test(renderMarkdown('[x](java\tscript:alert(1))')));
ok('drops data:/vbscript: links',
  !/href/.test(renderMarkdown('[x](data:text/html,<script>1</script>)')) &&
  !/href/.test(renderMarkdown('[x](vbscript:msgbox)')));
ok('no href attribute-quote breakout', (() => {
  const out = renderMarkdown('[x](" onpointerover="alert`1`)');
  // A raw `"` would open a second attribute; it must be escaped to &quot;.
  return !/onpointerover="/.test(out) && out.includes('&quot;');
})());
ok('keeps safe http(s)/mailto/relative links',
  /href="https:\/\//.test(renderMarkdown('[o](https://x.com)')) &&
  /href="\/docs/.test(renderMarkdown('[r](/docs/00)')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
