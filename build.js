/* ===========================================================
   build.js — "Build mode": the model writes a real project,
   we render it live and you keep iterating with prompts.

   Exposes a single global: window.BUILD
   Nothing here talks to the network — app.js owns the requests.
   =========================================================== */
'use strict';

const BUILD = (() => {

  /* ---------- injected by app.js so we stay decoupled ---------- */
  let host = { getChat: () => null, save: () => {}, toast: () => {} };

  let active = false;
  let tab = 'preview';        // preview | code
  let openFile = null;        // which file the code view shows
  let blobUrl = null;         // for "open in new tab"

  const $ = (id) => document.getElementById(id);

  /* =========================================================
     the project lives on the chat object, so it is saved and
     restored with the conversation like everything else
     ========================================================= */
  const files = () => {
    const c = host.getChat();
    if (!c) return {};
    if (!c.files) c.files = {};
    return c.files;
  };
  const names = () => Object.keys(files()).sort((a, b) => {
    const rank = (n) => (/index\.html?$/i.test(n) ? 0 : /\.html?$/i.test(n) ? 1 : /\.css$/i.test(n) ? 2 : /\.js$/i.test(n) ? 3 : 4);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const hasFiles = () => names().length > 0;

  /* =========================================================
     1. what we ask the model to do
     ========================================================= */
  const SYS = `
You are in BUILD MODE: a live workspace renders your code the moment you write it.

OUTPUT RULES — follow exactly, they are parsed by a program:
* Emit every file in a fenced block whose info string is \`file:<path>\`, e.g.
  \`\`\`file:index.html
  <!doctype html> ...
  \`\`\`
* Always output the COMPLETE file, never a diff, never "... rest unchanged".
* When changing something, re-emit only the files that actually change.
* Start with a one-line summary, then a short markdown checklist of what you
  are doing (\`- [x] done\` / \`- [ ] todo\`), then the files. Keep prose brief —
  the user reads the running result, not an essay.

TECHNICAL CONSTRAINTS of the preview sandbox:
* Plain \`.html\` / \`.css\` / \`.js\` only. No build step, no npm, no bundler,
  no JSX, and no ES-module \`import\` between your files (files are inlined).
* Reference siblings normally (\`<link href="styles.css">\`,
  \`<script src="app.js"></script>\`) — they get inlined automatically.
* CDN <script>/<link> tags are allowed (Tailwind, fonts, etc.).
* No network access to your own origin, no localStorage guarantees.
* Make it look genuinely good: sensible layout, spacing, responsive, dark-mode
  friendly. Ship something that works end-to-end rather than a stub.`.trim();

  /* Current files, so follow-ups edit reality instead of guessing.
     Cheap enough to resend while the project is small; above the cap we send
     the tree only and rely on the transcript. */
  function filesContext() {
    const n = names();
    if (!n.length) return '';
    const total = n.reduce((s, f) => s + files()[f].length, 0);
    if (total > 60000) {
      return '\n\nCURRENT PROJECT FILES (contents omitted — they are in the transcript above):\n'
        + n.map((f) => `- ${f} (${files()[f].split('\n').length} lines)`).join('\n');
    }
    return '\n\nCURRENT PROJECT FILES — this is the live state of the workspace. '
      + 'Base your edits on exactly this:\n\n'
      + n.map((f) => `\`\`\`file:${f}\n${files()[f]}\n\`\`\``).join('\n\n');
  }

  /* =========================================================
     2. pulling files back out of the reply
     ========================================================= */

  /* Which fences carry a path? Tolerant on purpose: models drift between
     ```file:index.html   ```html file="index.html"   ```index.html */
  function pathFromInfo(info) {
    const s = (info || '').trim().replace(/^\{|\}$/g, '').trim();
    if (!s) return null;
    let m = s.match(/(?:file|filename|path|src)\s*[:=]\s*["'`]?([\w./\-]+)["'`]?/i);
    if (m) return m[1];
    m = s.match(/^[a-z0-9+#]{1,12}\s*:\s*["'`]?([\w./\-]+\.[a-z0-9]{1,5})["'`]?$/i);
    if (m) return m[1];
    m = s.match(/^["'`]?([\w./\-]+\.(?:html?|css|js|mjs|json|md|txt|svg|xml))["'`]?$/i);
    if (m) return m[1];
    return null;
  }

  const FENCE = /^[ \t]*(?:```|~~~)([^\n]*)\n([\s\S]*?)(?:\n)?[ \t]*(?:```|~~~)[ \t]*$/gm;

  /* Read every file block in a reply. Returns {path: content}. */
  function parse(text) {
    const out = {};
    if (!text) return out;
    let m;
    FENCE.lastIndex = 0;
    while ((m = FENCE.exec(text))) {
      const p = pathFromInfo(m[1]);
      if (!p) continue;
      const clean = p.replace(/^\.?\//, '').replace(/\.\./g, '').trim();
      if (clean) out[clean] = m[2];
    }
    return out;
  }

  /* Merge a reply's files into the project. Returns the paths written. */
  function absorb(text) {
    const found = parse(text);
    const wrote = Object.keys(found);
    if (!wrote.length) return [];
    const f = files();
    wrote.forEach((p) => { f[p] = found[p]; });
    if (!openFile || !f[openFile]) openFile = names()[0];
    host.save();
    render();
    return wrote;
  }

  /* Chat transcripts shouldn't repeat a 400-line file — the workspace already
     shows it. Swap each block for a compact, clickable line. */
  function forDisplay(text) {
    if (!text) return text;
    let out = '';
    let last = 0;
    let m;
    FENCE.lastIndex = 0;
    while ((m = FENCE.exec(text))) {
      const p = pathFromInfo(m[1]);
      if (!p) continue;
      const lines = m[2].split('\n').length;
      out += text.slice(last, m.index)
        + `\n\`📄 ${p}\` · ${lines} line${lines === 1 ? '' : 's'} written\n`;
      last = m.index + m[0].length;
    }
    let rest = text.slice(last);

    /* A file still being streamed has an opening fence but no closing one.
       Collapse it too, otherwise hundreds of raw lines pour into the chat
       pane for a few seconds before snapping shut. */
    const open = rest.match(/(^|\n)[ \t]*(?:```|~~~)([^\n]*)\n([\s\S]*)$/);
    if (open && pathFromInfo(open[2])) {
      const n = open[3].split('\n').length;
      rest = rest.slice(0, open.index)
        + `\n\`📄 ${pathFromInfo(open[2])}\` · writing… ${n} line${n === 1 ? '' : 's'}\n`;
      return (out || text.slice(0, last)) + rest;
    }
    return out ? out + rest : text;
  }


  /* The little "Task 2 of 4" strip, read straight from the reply's checklist. */
  function progressOf(text) {
    const items = [...String(text || '').matchAll(/^[ \t]*[-*][ \t]*\[([ xX])\][ \t]*(.+)$/gm)]
      .map((m) => ({ done: m[1] !== ' ', label: m[2].trim() }));
    if (items.length < 2) return null;
    return { items, done: items.filter((i) => i.done).length };
  }

  /* =========================================================
     3. preview
     ========================================================= */
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function entryHtml() {
    const n = names();
    return n.find((f) => /^index\.html?$/i.test(f)) || n.find((f) => /\.html?$/i.test(f)) || null;
  }

  /* Build one self-contained document: relative <link>/<script> are replaced
     with the real file contents, because an iframe can't fetch our virtual FS. */
  function assemble() {
    const f = files();
    const entry = entryHtml();

    let doc;
    if (entry) {
      doc = f[entry];
    } else {
      const css = names().filter((x) => /\.css$/i.test(x));
      const js = names().filter((x) => /\.js$/i.test(x));
      if (!css.length && !js.length) return null;
      doc = '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + css.map((c) => `<link rel="stylesheet" href="${c}">`).join('')
        + '</head><body>'
        + js.map((j) => `<script src="${j}"></script>`).join('')
        + '</body></html>';
    }

    const local = (href) => {
      if (!href) return null;
      const k = href.replace(/^\.?\//, '').split(/[?#]/)[0];
      return Object.prototype.hasOwnProperty.call(f, k) ? k : null;
    };

    doc = doc.replace(/<link\b[^>]*>/gi, (tag) => {
      const h = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      const k = local(h);
      return k ? `<style>\n${f[k]}\n</style>` : tag;
    });

    doc = doc.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, inner) => {
      const s = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
      const k = local(s);
      if (!k) return tag;
      const type = /type\s*=\s*["']module["']/i.test(attrs) ? ' type="module"' : '';
      return `<script${type}>\n${f[k]}\n</script>`;
    });

    /* Surface script errors in the preview instead of hiding them in a console
       the user never opens — that's usually the next thing to fix. */
    const reporter = `<script>
(function(){
  function show(msg){
    var b=document.getElementById('__err__');
    if(!b){b=document.createElement('div');b.id='__err__';
      b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'+
      'background:#3b1113;color:#ffb4ad;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;'+
      'padding:8px 12px;border-top:1px solid #7f1d1d;white-space:pre-wrap;max-height:45%;overflow:auto';
      (document.body||document.documentElement).appendChild(b);}
    b.textContent+=(b.textContent?'\\n':'')+msg;
  }
  addEventListener('error',function(e){
    show('⚠ '+(e.message||'Script error')+(e.filename?'  ('+(e.lineno||0)+':'+(e.colno||0)+')':''));
  });
  addEventListener('unhandledrejection',function(e){
    show('⚠ Unhandled promise rejection: '+((e.reason&&(e.reason.message||e.reason))||''));
  });
})();
</script>`;

    return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, reporter + '</body>') : doc + reporter;
  }

  function renderPreview() {
    const frame = $('wsFrame');
    const doc = assemble();
    if (!frame) return;
    if (!doc) { frame.removeAttribute('srcdoc'); return; }
    frame.srcdoc = doc;
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }

  /* =========================================================
     4. code view
     ========================================================= */
  function renderCode() {
    const pane = $('wsCode');
    if (!pane) return;
    const n = names();
    pane.innerHTML = '';
    if (!n.length) return;
    if (!openFile || !n.includes(openFile)) openFile = n[0];

    const tree = document.createElement('div');
    tree.className = 'ws-tree';
    n.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'ws-f' + (f === openFile ? ' on' : '');
      b.innerHTML = `<span class="fi">${/\.html?$/i.test(f) ? '🌐' : /\.css$/i.test(f) ? '🎨' : /\.js$/i.test(f) ? '⚙' : '📄'}</span>`;
      b.appendChild(Object.assign(document.createElement('span'), { className: 'fn', textContent: f }));
      b.onclick = () => { openFile = f; renderCode(); };
      tree.appendChild(b);
    });

    const wrap = document.createElement('div');
    wrap.className = 'ws-src';
    const bar = document.createElement('div');
    bar.className = 'ws-srcbar';
    bar.appendChild(Object.assign(document.createElement('b'), { textContent: openFile }));
    const cp = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Copy' });
    cp.onclick = () => navigator.clipboard.writeText(files()[openFile] || '').then(() => host.toast('Copied ' + openFile, 'ok'));
    const dl = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Save' });
    dl.onclick = () => download(openFile, files()[openFile] || '');
    bar.append(cp, dl);

    const pre = document.createElement('pre');
    pre.className = 'ws-pre';
    const src = files()[openFile] || '';
    pre.innerHTML = '<code>' + src.split('\n')
      .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l) || ' '}`).join('\n') + '</code>';

    wrap.append(bar, pre);
    pane.append(tree, wrap);
  }

  /* =========================================================
     5. chrome
     ========================================================= */
  function render() {
    const ws = $('workspace');
    if (!ws) return;
    ws.hidden = !active;
    document.body.classList.toggle('build-mode', active);
    if (!active) return;

    const some = hasFiles();
    $('wsEmpty').hidden = some;
    $('wsBody').hidden = !some;
    $('wsPreview').hidden = tab !== 'preview';
    $('wsCode').hidden = tab !== 'code';
    document.querySelectorAll('.ws-tab').forEach((b) => b.classList.toggle('active', b.dataset.ws === tab));
    $('wsCount').textContent = some ? names().length + ' file' + (names().length === 1 ? '' : 's') : '';

    if (!some) return;
    if (tab === 'preview') renderPreview(); else renderCode();
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name.split('/').pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function openInTab() {
    const doc = assemble();
    if (!doc) { host.toast('Nothing to preview yet', 'error'); return; }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    window.open(blobUrl, '_blank');
  }

  /* ---------- zip (stored, no deps) ---------- */
  let CRC;
  function crc32(u8) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC[i] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    entries.forEach((e) => {
      const nm = enc.encode(e.name);
      const data = enc.encode(e.text);
      const crc = crc32(data);
      const lh = new Uint8Array(30 + nm.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
      dv.setUint16(8, 0, true); dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true); dv.setUint16(26, nm.length, true);
      lh.set(nm, 30);
      parts.push(lh, data);

      const ch = new Uint8Array(46 + nm.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true); cv.setUint16(28, nm.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nm, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eo = new Uint8Array(22);
    const ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, eo], { type: 'application/zip' });
  }

  function downloadZip() {
    const n = names();
    if (!n.length) { host.toast('No files yet', 'error'); return; }
    const c = host.getChat();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip(n.map((f) => ({ name: f, text: files()[f] }))));
    a.download = ((c && c.title) || 'project').replace(/[^\w -]+/g, '_').slice(0, 40) + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    host.toast('Downloaded ' + n.length + ' files', 'ok');
  }

  /* =========================================================
     6. init
     ========================================================= */
  function init(h) {
    host = Object.assign(host, h || {});
    document.querySelectorAll('.ws-tab').forEach((b) => {
      b.onclick = () => { tab = b.dataset.ws; render(); };
    });
    $('wsRefresh').onclick = () => { tab = 'preview'; render(); renderPreview(); host.toast('Preview reloaded', 'ok'); };
    $('wsOpen').onclick = openInTab;
    $('wsZip').onclick = downloadZip;
  }

  return {
    init,
    get active() { return active; },
    setActive(v) { active = !!v; render(); },
    systemPrompt: () => SYS,
    filesContext,
    absorb, parse, forDisplay, progressOf,
    hasFiles, names, files,
    render,
    clear() { const c = host.getChat(); if (c) c.files = {}; openFile = null; host.save(); render(); },
  };
})();

window.BUILD = BUILD;
