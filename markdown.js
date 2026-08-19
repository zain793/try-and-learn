/* ===========================================================
   markdown.js — tiny, dependency-free Markdown → HTML renderer
   Safe by design: everything is escaped first, then a limited
   set of inline/block constructs is turned into markup.
   =========================================================== */
(function (global) {
  'use strict';

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------- inline ---------- */
  function inline(src) {
    let s = esc(src);

    // `code`
    const codes = [];
    s = s.replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => {
      codes.push(code);
      return `\u0000C${codes.length - 1}\u0000`;
    });

    // images ![alt](url)  → only http(s)/data:image
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, url) =>
      /^(https?:|data:image\/)/i.test(url) ? `<img src="${url}" alt="${alt}">` : m);

    // links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, txt, url) =>
      /^(https?:|mailto:|#|\/)/i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>` : m);

    // bare urls
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g,
      (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // restore code spans
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  /* ---------- table helper ---------- */
  const isDivider = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

  /* ---------- blocks ---------- */
  function render(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    let out = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const mark = fence[1][0].repeat(3);
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + (mark === '`' ? '`' : '~') + '{3,}\\s*$').test(lines[i])) {
          buf.push(lines[i]); i++;
        }
        i++; // closing fence
        out += `<div class="code"><div class="code-head"><span>${esc(lang || 'text')}</span>` +
               `<button type="button" data-copy>Copy</button></div>` +
               `<pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
        continue;
      }

      // blank
      if (!line.trim()) { i++; continue; }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const n = h[1].length; out += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

      // hr
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out += '<hr>'; i++; continue; }

      // table
      if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        let body = '';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          body += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
          i++;
        }
        out += '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') +
               '</tr></thead><tbody>' + body + '</tbody></table>';
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out += `<blockquote>${render(buf.join('\n'))}</blockquote>`;
        continue;
      }

      // lists (supports nesting by indentation)
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const baseIndent = line.match(/^\s*/)[0].length;
        let html = '';
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const ind = lines[i].match(/^\s*/)[0].length;
          if (ind < baseIndent) break;
          const item = [lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')];
          i++;
          // continuation / nested lines
          while (i < lines.length && lines[i].trim() &&
                 !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
                 lines[i].match(/^\s*/)[0].length > baseIndent) {
            item.push(lines[i].replace(new RegExp('^\\s{0,' + (baseIndent + 2) + '}'), '')); i++;
          }
          // nested list
          while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
                 lines[i].match(/^\s*/)[0].length > baseIndent) {
            item.push(lines[i].replace(new RegExp('^\\s{0,' + (baseIndent + 2) + '}'), '')); i++;
          }
          const text = item.join('\n');
          const inner = /\n\s*([-*+]|\d+[.)])\s+/.test('\n' + text.split('\n').slice(1).join('\n'))
            ? render(text) : inline(text.replace(/\n+/g, ' '));
          const task = text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
          html += task
            ? `<li><input type="checkbox" disabled ${task[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inline(task[2])}</li>`
            : `<li>${inner}</li>`;
        }
        out += ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`;
        continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#{1,6}\s|>|([-*+]|\d+[.)])\s|`{3,}|~{3,})/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
    return out;
  }

  /* copy-button delegation (works for every rendered code block) */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const code = b.closest('.code')?.querySelector('code')?.innerText ?? '';
    navigator.clipboard.writeText(code).then(() => {
      const old = b.textContent; b.textContent = 'Copied ✓';
      setTimeout(() => { b.textContent = old; }, 1400);
    });
  });

  global.MD = { render, escape: esc };
})(window);
