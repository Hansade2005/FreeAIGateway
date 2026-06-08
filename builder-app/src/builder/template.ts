import type { FileSystemTree } from '@webcontainer/api'
import { PACKAGE_LOCK } from './template-lock'
// Inlined into the bridge so screenshots work WITHOUT a network/CDN import —
// the WebContainer preview is cross-origin isolated, which blocks cross-origin
// module imports (COEP). The UMD build sets the `htmlToImage` global.
import htmlToImageJs from 'html-to-image/dist/html-to-image.js?raw'

// Bridge injected into the preview: forwards console output + errors to the
// builder and answers DOM / screenshot requests over postMessage. Shipped in the
// template's index.html AND injected into older projects that predate it.
export const PREVIEW_BRIDGE = `<script>
  /* fag-bridge:8 */
  ${htmlToImageJs}
  (function () {
    function post(p) { try { parent.postMessage(p, '*'); } catch (e) {} }
    function send(kind, message, stack) { post({ __fagPreview: true, kind: kind, message: String(message), stack: stack ? String(stack) : '' }); }
    ['log', 'info', 'warn', 'error'].forEach(function (level) {
      var orig = console[level];
      console[level] = function () {
        try {
          var text = Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ');
          post({ __fagConsole: true, level: level, text: text });
        } catch (e) {}
        return orig.apply(console, arguments);
      };
    });
    window.addEventListener('error', function (e) { send('error', e.message, e.error && e.error.stack); });
    window.addEventListener('unhandledrejection', function (e) { send('unhandledrejection', (e.reason && e.reason.message) || e.reason, e.reason && e.reason.stack); });
    // On every (re)load tell the parent to drop stale logs, so the console buffer
    // reflects only the freshly-loaded page (no leftover pre-fix errors).
    post({ __fagReset: true });
    window.addEventListener('load', function () { post({ __fagReset: true }); });

    // ── Agent DOM-control commands (same-origin → full control of the app) ──
    function $q(s) { return document.querySelector(s); }
    function must(s) { var el = $q(s); if (!el) throw new Error('No element matches: ' + s); return el; }
    function clamp(t, n) { t = t || ''; return t.length > n ? t.slice(0, n) + '…' : t; }
    function centerOf(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    // Dispatch a full, framework-friendly pointer + mouse sequence (React-safe).
    function realClick(el, button) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      var c = centerOf(el);
      var base = { bubbles: true, cancelable: true, composed: true, clientX: c.x, clientY: c.y, button: button || 0, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, base))); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mousedown', base));
      try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, isPrimary: true }, base))); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    }
    // React tracks input state internally — assigning el.value is ignored. Use the
    // native setter so the framework's onChange actually fires.
    function setNativeValue(el, value) {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function pressKeyOn(el, key, mods) {
      mods = mods || {}; var t = el || document.activeElement || document.body;
      var o = { bubbles: true, cancelable: true, key: key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta };
      t.dispatchEvent(new KeyboardEvent('keydown', o));
      t.dispatchEvent(new KeyboardEvent('keyup', o));
    }
    function safe(v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return String(v); } }

    // Resolve a target element from EITHER a [ref=eN] handle (from snapshot) or a
    // CSS selector. Refs are the reliable path — the agent picks them from the
    // accessibility snapshot instead of guessing selectors.
    function target(a) {
      var el = a && a.ref ? document.querySelector('[data-fag-ref="' + a.ref + '"]')
             : a && a.selector ? $q(a.selector) : null;
      if (!el) throw new Error('No element for ' + (a && a.ref ? 'ref ' + a.ref : a && a.selector ? a.selector : '(no ref/selector)'));
      return el;
    }
    // ── Accessibility snapshot (Playwright-style ref tree) ──
    function roleOf(el) {
      var r = el.getAttribute('role'); if (r) return r;
      var tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') { var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        if (t === 'range') return 'slider'; return 'textbox'; }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'nav') return 'navigation'; if (tag === 'main') return 'main';
      if (tag === 'header') return 'banner'; if (tag === 'footer') return 'contentinfo';
      if (tag === 'ul' || tag === 'ol') return 'list'; if (tag === 'li') return 'listitem';
      if (tag === 'form') return 'form'; if (tag === 'label') return 'label'; if (tag === 'table') return 'table';
      return null;
    }
    function isInteractive(el) {
      var t = el.tagName.toLowerCase();
      return t === 'a' || t === 'button' || t === 'input' || t === 'textarea' || t === 'select'
        || el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || (el.tabIndex != null && el.tabIndex >= 0);
    }
    function accName(el) {
      var n = el.getAttribute('aria-label'); if (n) return n;
      var lb = el.getAttribute('aria-labelledby'); if (lb) { var rr = document.getElementById(lb); if (rr) return (rr.innerText || '').trim(); }
      if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
      if (el.tagName === 'INPUT') { var ty = (el.getAttribute('type') || '').toLowerCase();
        if (ty === 'submit' || ty === 'button') return el.value || '';
        return el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || ''; }
      var own = ''; for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === 3) own += c.nodeValue; }
      own = own.trim(); if (own) return own;
      var tit = el.getAttribute('title'); if (tit) return tit;
      return (el.innerText || '').trim();
    }
    function isVisible(el) {
      var s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0;
    }
    // Build the accessibility ref tree (also re-assigns the data-fag-ref handles).
    function buildSnapshot() {
      var old = document.querySelectorAll('[data-fag-ref]');
      for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-fag-ref');
      var lines = []; var n = 0; var CAP = 200;
      function walk(el, depth) {
        if (lines.length >= CAP) return;
        for (var i = 0; i < el.children.length; i++) {
          var c = el.children[i]; var tag = c.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          if (!isVisible(c)) continue;
          var role = roleOf(c); var emit = role || isInteractive(c); var childDepth = depth;
          if (emit) {
            var name = accName(c).replace(/\\s+/g, ' ').trim(); if (name.length > 60) name = name.slice(0, 60) + '…';
            var ref = 'e' + (++n); c.setAttribute('data-fag-ref', ref);
            var pad = ''; for (var dd = 0; dd < depth; dd++) pad += '  ';
            lines.push(pad + '- ' + (role || 'generic') + (name ? ' "' + name + '"' : '') + ' [ref=' + ref + ']');
            childDepth = depth + 1;
          }
          walk(c, childDepth);
        }
      }
      walk(document.body, 0);
      return lines.join('\\n') || '(no interactive elements found)';
    }
    function pageScroll() {
      var se = document.scrollingElement || document.documentElement;
      return { y: se.scrollTop, height: se.scrollHeight, viewport: se.clientHeight,
        atBottom: Math.ceil(se.scrollTop + se.clientHeight) >= se.scrollHeight, atTop: se.scrollTop <= 0 };
    }
    // Let the app re-render / navigate after an action, then report the new state
    // (fresh snapshot + scroll position) so the agent can continue by ref.
    function stateAfter(label) {
      return new Promise(function (res) {
        requestAnimationFrame(function () { setTimeout(function () {
          res({ ok: label, url: location.href, title: document.title, scroll: pageScroll(), snapshot: buildSnapshot() });
        }, 150); });
      });
    }

    var COMMANDS = {
      // Playwright-style accessibility snapshot: a YAML-ish tree of roles + names
      // with stable [ref=eN] handles the agent then passes to click/fill/etc.
      snapshot: function () { return buildSnapshot(); },
      inspect: function (a) {
        if (!a.selector && !a.ref) return { url: location.href, title: document.title, text: clamp(document.body && document.body.innerText, 4000) };
        var el = target(a); var cs = getComputedStyle(el); var r = el.getBoundingClientRect();
        var keys = ['color', 'background-color', 'font-size', 'font-family', 'font-weight', 'line-height', 'display', 'padding', 'margin', 'border', 'border-radius', 'width', 'height', 'position', 'opacity', 'box-shadow'];
        var styles = {}; keys.forEach(function (k) { styles[k] = cs.getPropertyValue(k); });
        var attrs = {}; for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value;
        return { tag: el.tagName.toLowerCase(), text: clamp(el.innerText, 500), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, styles: styles, attributes: attrs };
      },
      // Interactions return the RESULTING page state (fresh snapshot + scroll), so
      // the agent immediately sees the effect and continues by ref.
      click: function (a) { realClick(target(a), a.button || 0); return stateAfter('clicked ' + (a.ref || a.selector)); },
      fill: function (a) { setNativeValue(target(a), a.value == null ? '' : String(a.value)); return stateAfter('filled ' + (a.ref || a.selector)); },
      pressKey: function (a) { pressKeyOn((a.ref || a.selector) ? target(a) : null, a.key, a.modifiers); return stateAfter('pressed ' + a.key); },
      scroll: function (a) {
        var el = (a.ref || a.selector) ? target(a) : null; var to = a.to;
        if (to === 'bottom') { var h = el ? el.scrollHeight : document.body.scrollHeight; if (el) el.scrollTop = h; else window.scrollTo({ top: h }); }
        else if (to === 'top') { if (el) el.scrollTop = 0; else window.scrollTo({ top: 0 }); }
        else { var nn = Number(to) || 0; if (el) el.scrollTop = nn; else window.scrollTo({ top: nn }); }
        return stateAfter('scrolled ' + to + (el ? ' (elementScrollTop=' + el.scrollTop + ')' : ''));
      },
      // Arbitrary JS escape hatch (submit forms, inject scripts, drive scrollbars,
      // anything). Result is JSON-sanitized for postMessage.
      evaluate: function (a) { return Promise.resolve((0, eval)(a.code)).then(safe); },
    };

    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.__fagReq === 'dom') {
        var html = (document.documentElement && document.documentElement.outerHTML) || '';
        post({ __fagRes: 'dom', id: d.id, html: html.length > 16000 ? html.slice(0, 16000) + '\\n<!-- …truncated… -->' : html });
      } else if (d.__fagReq === 'shot') {
        (async function () {
          // html-to-image (inlined above, no CDN) renders via SVG foreignObject,
          // so modern CSS colors (oklch/oklab, Tailwind v4) work.
          function bg(el) { var c = getComputedStyle(el).backgroundColor; return (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') ? c : ''; }
          var H = (typeof htmlToImage !== 'undefined' && htmlToImage) || window.htmlToImage;
          if (!H || !H.toJpeg) { post({ __fagRes: 'shot', id: d.id, error: 'screenshot library unavailable' }); return; }
          try {
            var color = bg(document.body) || bg(document.documentElement) || '#ffffff';
            var dataUrl = await H.toJpeg(document.body, { quality: 0.7, pixelRatio: 0.6, backgroundColor: color, cacheBust: true });
            post({ __fagRes: 'shot', id: d.id, dataUrl: dataUrl });
          } catch (err) { post({ __fagRes: 'shot', id: d.id, error: (err && err.message) || String(err) }); }
        })();
      } else if (d.__fagReq === 'cmd') {
        Promise.resolve().then(function () {
          var fn = COMMANDS[d.cmd];
          if (!fn) throw new Error('unknown command: ' + d.cmd);
          return fn(d.args || {});
        }).then(function (result) {
          post({ __fagRes: 'cmd', id: d.id, result: result === undefined ? null : result });
        }).catch(function (err) {
          post({ __fagRes: 'cmd', id: d.id, error: String((err && err.message) || err) });
        });
      }
    });
  })();
</script>`

// The bridge JS without the <script> wrapper — for frameworks that inject head
// scripts programmatically (Next.js layout, Nuxt config) rather than via a
// static index.html.
export const BRIDGE_BODY = PREVIEW_BRIDGE.replace(/^<script>\s*/, '').replace(/\s*<\/script>$/, '')

// Marker baked into the current bridge so we can tell whether a project already
// has the latest version (and skip rewriting it).
const BRIDGE_MARKER = 'fag-bridge:8'
// Matches a previously-injected bridge script (any version) so it can be
// stripped and replaced — attribute-less <script> blocks that reference our
// postMessage protocol. The app's own `<script type="module">` is untouched.
const OLD_BRIDGE_RE = /<script>[\s\S]*?__fag(?:Req|Preview)[\s\S]*?<\/script>\s*/g

// Ensure the project's index.html carries the CURRENT preview bridge. Older
// projects predate the bridge (DOM/screenshot would hang) or carry the v1
// html2canvas bridge (screenshots fail on Tailwind v4's oklch colors) — both
// are upgraded in place.
export function ensureBridge(html: string): string {
  if (!html || html.includes(BRIDGE_MARKER)) return html
  const stripped = html.replace(OLD_BRIDGE_RE, '')
  return stripped.includes('</head>') ? stripped.replace('</head>', `  ${PREVIEW_BRIDGE}\n  </head>`) : PREVIEW_BRIDGE + stripped
}

// The starter project the agent edits: Vite + React 18 + Tailwind v4. Kept
// deliberately small so free models can reason over the whole thing. The agent
// rewrites/creates files under src/ (and may add deps to package.json).
//
// index.html embeds a tiny runtime-error reporter that postMessages uncaught
// errors to the parent window, so the builder can surface them and feed them
// back into the agent for an auto-fix.

export const STARTER_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'fag-app',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        '@tailwindcss/vite': '^4.0.0',
        tailwindcss: '^4.0.0',
        vite: '^5.4.10',
      },
    },
    null,
    2,
  ),
  'vite.config.js': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true },
})
`,
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    ${PREVIEW_BRIDGE}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  'src/main.jsx': `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
  'src/index.css': `@import "tailwindcss";
`,
  'src/App.jsx': `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-semibold">Your app starts here</h1>
        <p className="text-neutral-400">Describe what you want to build in the chat →</p>
      </div>
    </div>
  )
}
`,
  // Pinned lockfile so the in-browser `npm install` skips dependency resolution.
  'package-lock.json': PACKAGE_LOCK,
}

// Convert the flat path→content map into the nested tree WebContainer.mount wants.
export function toFileSystemTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    let node: any = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]
      node[dir] ??= { directory: {} }
      node = node[dir].directory
    }
    node[parts[parts.length - 1]] = { file: { contents } }
  }
  return tree
}
