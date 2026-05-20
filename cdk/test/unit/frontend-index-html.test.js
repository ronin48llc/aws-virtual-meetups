'use strict';

// Guard test: prevents reintroducing inline <script> blocks (which would
// force the CloudFront CSP to keep 'unsafe-inline') or external CDN script
// tags without Subresource Integrity attributes.
// Tracks issue #22.

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.resolve(__dirname, '../../../frontend/index.html');

function loadIndexHtml() {
  return fs.readFileSync(INDEX_HTML, 'utf8');
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function findScriptTags(html) {
  // Strip HTML comments first so a literal "<script>" inside a comment
  // (e.g. usage docs in a banner comment) doesn't get parsed as a real tag.
  html = stripHtmlComments(html);

  // Match every <script ...> opening tag (with or without attributes,
  // including those spanning multiple lines). We don't try to parse the
  // body — empty body vs. inline body is decided by re-scanning below.
  const tags = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const start = m.index;
    const openEnd = re.lastIndex;
    // Find the matching </script>
    const closeIdx = html.indexOf('</script>', openEnd);
    const body = closeIdx === -1 ? '' : html.slice(openEnd, closeIdx);
    tags.push({ attrs, body, raw: html.slice(start, closeIdx + '</script>'.length) });
  }
  return tags;
}

function hasSrc(attrs) {
  return /\bsrc\s*=/.test(attrs);
}

function getSrc(attrs) {
  const m = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function isExternalSrc(src) {
  return /^https?:\/\//i.test(src);
}

function hasIntegrity(attrs) {
  return /\bintegrity\s*=\s*["']sha(256|384|512)-[A-Za-z0-9+/=_-]+["']/.test(attrs);
}

function hasCrossorigin(attrs) {
  return /\bcrossorigin\s*=/.test(attrs);
}

describe('frontend/index.html security guards (issue #22)', () => {
  const html = loadIndexHtml();
  const tags = findScriptTags(html);

  test('parses at least one <script> tag (sanity)', () => {
    expect(tags.length).toBeGreaterThan(0);
  });

  test('no inline <script> blocks — all <script> tags must carry src=', () => {
    const inline = tags.filter((t) => !hasSrc(t.attrs) && t.body.trim().length > 0);
    if (inline.length > 0) {
      // Surface the offending tag(s) in the failure message so re-adders see exactly what broke.
      const detail = inline.map((t) => `  - ${t.raw.slice(0, 120)}...`).join('\n');
      throw new Error(
        `Inline <script> blocks are not allowed in frontend/index.html — ` +
        `they force the CloudFront CSP to permit 'unsafe-inline'. ` +
        `Move the code to a same-origin JS file under frontend/js/ and reference it with src=.\n` +
        `Offending tags:\n${detail}`,
      );
    }
  });

  test('every external CDN <script src=https://...> carries integrity= and crossorigin=', () => {
    const external = tags.filter((t) => {
      const src = getSrc(t.attrs);
      return src && isExternalSrc(src);
    });
    expect(external.length).toBeGreaterThan(0);
    const missing = external.filter((t) => !hasIntegrity(t.attrs) || !hasCrossorigin(t.attrs));
    if (missing.length > 0) {
      const detail = missing
        .map((t) => `  - ${getSrc(t.attrs)} (integrity=${hasIntegrity(t.attrs)}, crossorigin=${hasCrossorigin(t.attrs)})`)
        .join('\n');
      throw new Error(
        `External CDN <script> tags must include integrity="sha384-..." and crossorigin="anonymous". ` +
        `Without SRI, a CDN compromise injects arbitrary JS into every page.\n` +
        `Offending tags:\n${detail}`,
      );
    }
  });

  test('no external <script src=...> uses a floating jsdelivr major-version tag like @1 or @6', () => {
    // Floating tags break SRI (the file behind the tag can change), so we
    // require explicit semver pins (e.g. hls.js@1.6.16).
    const external = tags
      .map((t) => getSrc(t.attrs))
      .filter((s) => s && isExternalSrc(s) && /cdn\.jsdelivr\.net/.test(s));
    const floating = external.filter((src) => /@\d+\//.test(src) && !/@\d+\.\d+\.\d+/.test(src));
    if (floating.length > 0) {
      throw new Error(
        `jsdelivr URLs must pin a full semver, not a floating major tag (@1, @6, ...).\n` +
        `Offending URLs:\n${floating.map((s) => `  - ${s}`).join('\n')}`,
      );
    }
  });
});
