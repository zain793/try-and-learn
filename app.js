/* ===========================================================
   app.js — AgentRouter Chat
   Works with:
     • Anthropic style  →  {base}/v1/messages
     • OpenAI style     →  {base}/v1/chat/completions
   Everything (key, chats, prefs) is stored in localStorage.
   =========================================================== */
'use strict';

/* ---------------- constants ---------------- */
const LS_CFG = 'ar.cfg.v1';
const LS_CHATS = 'ar.chats.v1';

const DEFAULT_MODELS = [
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gpt-5.6-sol',
  'gpt-5.2',
  'gpt-4.1',
  'o4-mini',
];

const DEFAULTS = {
  provider: 'anthropic',
  keys: { anthropic: '', openai: '' },
  useCustomBase: true,
  baseUrl: 'https://agentrouter.org/',
  model: 'claude-opus-5',
  models: DEFAULT_MODELS.slice(),
  favorites: ['claude-opus-4-8', 'claude-opus-5', 'gpt-5.6-sol'],
  thinking: 'xhigh',
  maxTokens: 8192,
  temperature: 1,
  systemPrompt: 'You are a helpful, precise assistant. Use Markdown for formatting.',
  streaming: true,
  useProxy: true,
  autoTitle: true,         // let the model name each chat

  client: 'claude-code',   // identity sent upstream (see CLIENTS below)
  theme: 'dark',
};


/* ---------------------------------------------------------------
   Client identity presets.
   Relays like AgentRouter inspect the calling client and answer
   "unauthorized client detected" (HTTP 401) unless the request looks
   like an official CLI/SDK. Browsers forbid setting User-Agent from
   fetch(), so we hand these to the local proxy (x-ar-ua / x-ar-extra)
   and it applies them server-side.
   --------------------------------------------------------------- */
const CLIENTS = {
  'claude-code': {
    label: 'Claude Code CLI (recommended for Claude)',
    ua: 'claude-cli/1.0.60 (external, cli)',
    headers: {
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.60.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.14.0',
      'x-stainless-retry-count': '0',
    },
  },
  codex: {
    label: 'Codex / OpenAI CLI (recommended for GPT)',
    ua: 'codex_cli_rs/0.20.0 (Windows 10; x86_64)',
    headers: { originator: 'codex_cli_rs', 'x-app': 'cli' },
  },
  'openai-node': {
    label: 'OpenAI Node SDK',
    ua: 'OpenAI/NodeJS 4.104.0',
    headers: {
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '4.104.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.14.0',
    },
  },
  'openai-python': {
    label: 'OpenAI Python SDK',
    ua: 'OpenAI/Python 1.99.1',
    headers: {
      'x-stainless-lang': 'python',
      'x-stainless-package-version': '1.99.1',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'CPython',
      'x-stainless-runtime-version': '3.11.9',
    },
  },
  browser: { label: 'Browser (no spoofing)', ua: '', headers: {} },
};

/* thinking effort → token budget for Anthropic extended thinking */
const THINK_BUDGET = { none: 0, low: 2048, medium: 6144, high: 12288, xhigh: 24576 };

/* thinking effort → reasoning_effort for OpenAI style */
const THINK_EFFORT = { none: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

/* model → chip icon + accent colour (mirrors the look of the screenshot) */
const MODEL_STYLE = [
  [/opus/i,           { ic: '✳', c: '#e8863c' }],
  [/sonnet/i,         { ic: '✳', c: '#c9791f' }],
  [/haiku/i,          { ic: '✳', c: '#b8863c' }],
  [/claude/i,         { ic: '✳', c: '#d97757' }],
  [/^o\d|gpt|sol/i,   { ic: '◎', c: '#10a37f' }],
  [/gemini/i,         { ic: '✦', c: '#4285f4' }],
  [/grok/i,           { ic: '✕', c: '#8b8b8b' }],
  [/deepseek/i,       { ic: '⌬', c: '#4d6bfe' }],
  [/llama|mistral|qwen/i, { ic: '⬢', c: '#7c5cff' }],
];
const styleOf = (m) => (MODEL_STYLE.find(([re]) => re.test(m)) || [null, { ic: '◈', c: '#6f8dff' }])[1];

/* ---------------- tiny helpers ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const approxTokens = (s) => Math.max(1, Math.round(String(s).length / 4));

function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}

/* ---------------- state ---------------- */
let cfg = Object.assign(structuredClone(DEFAULTS), load(LS_CFG, DEFAULTS));
cfg.keys = Object.assign({ anthropic: '', openai: '' }, cfg.keys);
cfg.models = (cfg.models && cfg.models.length) ? cfg.models : DEFAULT_MODELS.slice();
cfg.favorites = Array.isArray(cfg.favorites) ? cfg.favorites : [];


/* First visit on a deployed site → default to DIRECT browser calls.
   A server-side proxy runs on datacenter IPs, and AgentRouter's firewall
   answers those with an HTML challenge instead of JSON. The visitor's own
   IP is not blocked, and the relay sends `Access-Control-Allow-Origin: *`,
   so calling it straight from the page is both allowed and more reliable.
   Locally, server.py is still the best path (it can spoof User-Agent). */
if (!localStorage.getItem(LS_CFG)) {
  const local = location.protocol === 'file:'
    || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  cfg.useProxy = local;
  if (!local) cfg.client = 'codex';   // the identity this relay accepts
  saveCfgEarly();
}
function saveCfgEarly() { try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch {} }

let chats = load(LS_CHATS, []);

let currentId = chats[0]?.id || null;
let controller = null;      // AbortController for the in-flight request
let sessionTokens = 0;

function load(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? structuredClone(fb) : v; } catch { return structuredClone(fb); } }
const saveCfg = () => localStorage.setItem(LS_CFG, JSON.stringify(cfg));
const saveChats = () => localStorage.setItem(LS_CHATS, JSON.stringify(chats));

const chat = () => chats.find((c) => c.id === currentId);
function ensureChat() {
  if (!chat()) {
    const c = { id: uid(), title: 'New chat', model: cfg.model, provider: cfg.provider, ts: Date.now(), messages: [] };
    chats.unshift(c); currentId = c.id; saveChats(); renderChatList();
  }
  return chat();
}

/* ---------------- endpoint building ---------------- */
function baseUrl() {
  let b = (cfg.useCustomBase && cfg.baseUrl.trim())
    ? cfg.baseUrl.trim()
    : (cfg.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com');
  return b.replace(/\/+$/, '');
}
function endpoint() {
  let b = baseUrl();
  const path = cfg.provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  // don't double-append if the user already pasted a full path
  const url = /\/v1\/(messages|chat\/completions|responses)$/.test(b) ? b : b + path;
  return cfg.useProxy ? '/proxy?url=' + encodeURIComponent(url) : url;
}
function modelsUrl() {
  const url = baseUrl().replace(/\/v1\/.*$/, '') + '/v1/models';
  return cfg.useProxy ? '/proxy?url=' + encodeURIComponent(url) : url;
}
function authHeaders() {
  const key = cfg.keys[cfg.provider] || '';
  const h = { 'Content-Type': 'application/json' };
  if (cfg.provider === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
    h['authorization'] = 'Bearer ' + key;   // many relays accept/require this too
  } else {
    h['Authorization'] = 'Bearer ' + key;
  }

  /* Client identity. Relays that "detect unauthorized clients" need the
     request to look like an official CLI/SDK. The browser can't set
     User-Agent, so the proxy applies these for us. */
  const id = CLIENTS[cfg.client] || CLIENTS['claude-code'];
  if (cfg.useProxy && id && id.ua) {
    h['x-ar-ua'] = id.ua;
    h['x-ar-extra'] = JSON.stringify(id.headers || {});
  } else if (id) {
    /* Direct from the browser (no proxy).
       Browsers can't set User-Agent, but AgentRouter's client check is
       satisfied by the `originator` header — verified: this exact value is
       accepted while any other value returns "unauthorized client detected".
       This is what makes a public deploy work: the call leaves the visitor's
       own IP, so the relay's firewall doesn't see a datacenter address. */
    Object.entries(id.headers || {}).forEach(([k, v]) => { h[k] = v; });
    if (cfg.client !== 'browser') h['originator'] = 'codex_cli_rs';
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  return h;

}


/* ---------------- request body ---------------- */
function buildBody(msgs, stream) {
  const think = cfg.thinking || 'none';
  if (cfg.provider === 'anthropic') {
    const body = {
      model: cfg.model,
      max_tokens: Number(cfg.maxTokens) || 8192,
      stream: !!stream,
      messages: msgs.map((m) => ({ role: m.role, content: m.content })),
    };
    if (cfg.systemPrompt.trim()) body.system = cfg.systemPrompt.trim();
    if (think !== 'none' && THINK_BUDGET[think]) {
      const budget = Math.min(THINK_BUDGET[think], Math.max(1024, body.max_tokens - 1024));
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // temperature must stay 1 when extended thinking is on
    } else {
      body.temperature = Number(cfg.temperature);
    }
    return body;
  }
  // OpenAI compatible
  const list = [];
  if (cfg.systemPrompt.trim()) list.push({ role: 'system', content: cfg.systemPrompt.trim() });
  msgs.forEach((m) => list.push({ role: m.role, content: m.content }));
  const body = {
    model: cfg.model,
    messages: list,
    stream: !!stream,
    max_tokens: Number(cfg.maxTokens) || 8192,
    temperature: Number(cfg.temperature),
  };
  if (stream) body.stream_options = { include_usage: true };
  if (THINK_EFFORT[think]) body.reasoning_effort = THINK_EFFORT[think];
  return body;
}

/* ---------------------------------------------------------------
   Firewall / anti-bot detection.
   AgentRouter sits behind Aliyun's WAF, which answers requests coming from
   cloud/datacenter IPs (i.e. a deployed serverless proxy) with an HTML
   challenge page instead of JSON. That's what produced the confusing
   "Unexpected token '<'" error. Detect it and say what to do.
   --------------------------------------------------------------- */
const WAF_RE = /aliyun_waf|<!doctype html|<html[\s>]/i;

function wafMessage() {
  return 'The relay replied with a firewall / anti-bot HTML page instead of JSON.'
    + (!isLocal() && cfg.useProxy
      ? '\n→ Its firewall blocks datacenter IPs, so this site\'s server-side proxy cannot reach it.'
        + '\n   Fix: open Settings and untick "Route through proxy" so requests go straight'
        + '\n   from your browser (allowed here — the relay sends CORS headers).'
      : '\n→ Try again in a moment, or open ' + baseUrl() + ' in a tab once to clear the challenge.');
}

/* JSON parse that explains itself when the body isn't JSON */
async function readJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch {
    if (WAF_RE.test(txt)) throw new Error(wafMessage());
    throw new Error('Expected JSON but the server returned:\n' + txt.slice(0, 200));
  }
}

/* extract a readable error from any shape the relay returns */
async function readError(res) {

  let detail = '';
  try {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      detail = j?.error?.message || j?.message || j?.error || txt;
      if (typeof detail === 'object') detail = JSON.stringify(detail);
    } catch { detail = txt; }
  } catch { /* ignore */ }
  const s = String(detail);
  if (WAF_RE.test(s)) return `HTTP ${res.status} — ${wafMessage()}`;
  const hint = /unauthorized client|client detected|invalid client/i.test(s)
    ? '\n→ The relay rejected the CLIENT, not your key. Open Settings → "Client identity" and pick '
      + '"Codex / OpenAI CLI", which is the identity this relay accepts.'
      + (cfg.useProxy ? '' : ' (Direct mode sends it as the "originator" header.)')

    : res.status === 401 ? '\n→ Check your API key.'
    : res.status === 404 ? '\n→ Check the base URL / model id.'

    : res.status === 429 ? '\n→ Rate limited or out of credits.'
    : res.status >= 500 ? '\n→ Upstream server error, try again.' : '';
  return `HTTP ${res.status} ${res.statusText}\n${String(detail).slice(0, 900)}${hint}`;
}

/* =========================================================
   rendering
   ========================================================= */
function chipNode(model, { active, removable, onPick, onRemove }) {
  const s = styleOf(model);
  const c = el('span', 'chip' + (active ? ' active' : ''));
  c.style.setProperty('--c', s.c);
  c.title = model;
  c.appendChild(el('span', 'ic', s.ic));
  c.appendChild(el('span', 'nm', model));
  if (removable) {
    const x = el('span', 'x', '✕');
    x.onclick = (e) => { e.stopPropagation(); onRemove?.(); };
    c.appendChild(x);
  }
  c.onclick = () => onPick?.();
  return c;
}

/* top bar shows the current chat title + model (chips were removed) */
function renderTopBar() {
  const c = chat();
  $('topTitle').textContent = (c && c.title) ? c.title : 'New chat';
  const s = styleOf(cfg.model);
  const m = $('topModel');
  m.textContent = s.ic + ' ' + cfg.model;
  m.style.color = s.c;
}


function renderFavChips() {
  const wrap = $('favChips'); wrap.innerHTML = '';
  cfg.favorites.forEach((m) => wrap.appendChild(chipNode(m, {
    active: m === cfg.model, removable: true,
    onPick: () => setModel(m),
    onRemove: () => { cfg.favorites = cfg.favorites.filter((x) => x !== m); saveCfg(); renderFavChips(); renderTopBar(); },

  })));
  if (!cfg.favorites.length) wrap.appendChild(el('span', 'hint', 'No pinned models — press ★ to pin the selected one.'));
}

function renderModelSelect() {
  const sel = $('modelSelect'); sel.innerHTML = '';
  const list = cfg.models.includes(cfg.model) ? cfg.models : [cfg.model, ...cfg.models];
  list.forEach((m) => {
    const o = el('option', null, m); o.value = m;
    if (m === cfg.model) o.selected = true;
    sel.appendChild(o);
  });
}

/* "2h ago", "Yesterday", "12 Aug" */
function whenLabel(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 172800) return 'yesterday';
  if (d < 604800) return Math.floor(d / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderChatList() {
  const wrap = $('chatList'); wrap.innerHTML = '';
  if (!chats.length) { wrap.appendChild(el('div', 'side-empty', 'No chats yet')); return; }

  chats.forEach((c) => {
    const row = el('div', 'chat-item' + (c.id === currentId ? ' active' : ''));
    row.appendChild(el('span', 'ic', styleOf(c.model || cfg.model).ic));

    // caption + a small second line so old chats are easy to recognise
    const txt = el('span', 't');
    const title = c.title || 'New chat';
    txt.appendChild(el('span', 'tt', title));
    const n = (c.messages || []).length;
    txt.appendChild(el('span', 'sub', whenLabel(c.ts) + (n ? ' · ' + n + ' msg' + (n === 1 ? '' : 's') : '')));
    txt.title = title;
    row.appendChild(txt);

    const acts = el('span', 'row-acts');

    const ren = el('span', 'act', '✎');
    ren.title = 'Rename this chat';
    ren.onclick = (e) => {
      e.stopPropagation();
      const v = prompt('Chat name:', title);
      if (v == null) return;
      const name = v.trim();
      if (name) { c.title = name.slice(0, 60); c.titleLocked = true; c.titleAuto = false; }
      else { c.titleLocked = false; c.titleAuto = true; recaption(c, { force: true }); }
      saveChats(); renderChatList(); renderTopBar();
    };
    acts.appendChild(ren);

    const re = el('span', 'act', '↻');
    re.title = 'Regenerate caption from the conversation';
    re.onclick = async (e) => {
      e.stopPropagation();
      c.titleLocked = false;
      await recaption(c, { force: true });
      toast('Caption updated', 'ok');
    };
    acts.appendChild(re);

    const del = el('span', 'act del', '🗑');
    del.title = 'Delete chat';
    del.onclick = (e) => {
      e.stopPropagation();
      chats = chats.filter((x) => x.id !== c.id);
      if (currentId === c.id) currentId = chats[0]?.id || null;
      saveChats(); renderChatList(); renderMessages();
    };
    acts.appendChild(del);

    row.appendChild(acts);
    row.onclick = () => { currentId = c.id; renderChatList(); renderMessages(); closeSidebar(); };
    wrap.appendChild(row);
  });
}


function welcome() {
  const w = el('div', 'welcome');
  w.innerHTML = `
    <h2>Try and Learn</h2>
    <p>Add your AgentRouter API key in <b>⚙ Settings</b> (bottom-left), choose a model, and start typing.</p>

    <div class="cards">
      <div class="card" data-p="Explain how HTTP streaming (SSE) works, with a small JS example."><b>Explain streaming</b>SSE with a JS example</div>
      <div class="card" data-p="Write a Python function that retries an HTTP request with exponential backoff."><b>Write code</b>Retry with backoff</div>
      <div class="card" data-p="Summarize the differences between Claude and GPT model families in a table."><b>Compare models</b>Claude vs GPT table</div>
      <div class="card" data-p="Review this idea and list risks: a browser-only chat UI that stores API keys in localStorage."><b>Review an idea</b>Risks &amp; mitigations</div>
    </div>`;
  w.querySelectorAll('.card').forEach((c) => c.onclick = () => { $('prompt').value = c.dataset.p; autoGrow(); $('prompt').focus(); });
  return w;
}

function messageNode(m, i) {
  const wrap = el('div', 'msg ' + m.role);
  const s = styleOf(m.model || cfg.model);
  const av = el('div', 'avatar', m.role === 'user' ? '🧑' : s.ic);
  if (m.role === 'assistant') av.style.setProperty('--c', s.c);
  wrap.appendChild(av);

  const bub = el('div', 'bub');

  const head = el('div', 'mhead');
  head.appendChild(el('span', 'who', m.role === 'user' ? 'You' : 'Assistant'));
  if (m.role === 'assistant' && m.model) head.appendChild(el('span', 'mdl', m.model));
  const act = el('div', 'mact');
  const copy = el('button', null, 'Copy');
  copy.onclick = () => navigator.clipboard.writeText(m.content || '').then(() => toast('Copied', 'ok'));
  act.appendChild(copy);
  if (m.role === 'user') {
    const ed = el('button', null, 'Edit');
    ed.onclick = () => { $('prompt').value = m.content; autoGrow(); $('prompt').focus(); };
    act.appendChild(ed);
  }
  if (m.role === 'assistant' && i === chat().messages.length - 1) {
    const rg = el('button', null, 'Retry');
    rg.onclick = () => { chat().messages.splice(i, 1); saveChats(); renderMessages(); send(null, true); };
    act.appendChild(rg);
  }
  const del = el('button', null, 'Delete');
  del.onclick = () => { chat().messages.splice(i, 1); saveChats(); renderMessages(); };
  act.appendChild(del);
  head.appendChild(act);
  bub.appendChild(head);

  if (m.thinking) {
    const d = el('details', 'think');
    d.appendChild(el('summary', null, '🧠 Thinking'));
    d.appendChild(el('div', 'tk', m.thinking));
    bub.appendChild(d);
  }

  const body = el('div', 'md');
  body.innerHTML = MD.render(m.content || '');
  bub.appendChild(body);

  if (m.error) bub.appendChild(el('div', 'err', m.error));

  if (m.usage) {
    const f = el('div', 'mfoot');
    const u = m.usage;
    if (u.in != null) f.appendChild(el('span', null, `in ${u.in}`));
    if (u.out != null) f.appendChild(el('span', null, `out ${u.out}`));
    if (u.ms != null) f.appendChild(el('span', null, `${(u.ms / 1000).toFixed(1)}s`));
    if (u.out != null && u.ms) f.appendChild(el('span', null, `${(u.out / (u.ms / 1000)).toFixed(1)} tok/s`));
    bub.appendChild(f);
  }

  wrap.appendChild(bub);
  return wrap;
}

function renderMessages() {
  const box = $('messages'); box.innerHTML = '';
  const c = chat();
  if (!c || !c.messages.length) { box.appendChild(welcome()); updateMeta(); return; }
  c.messages.forEach((m, i) => box.appendChild(messageNode(m, i)));
  box.scrollTop = box.scrollHeight;
  updateMeta();
}

function updateMeta() {
  const c = chat();
  const n = c ? c.messages.length : 0;
  $('composerMeta').innerHTML =
    `<span><b>${cfg.model}</b></span>` +
    `<span>${cfg.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · ${baseUrl()}</span>` +
    `<span>thinking: <b>${cfg.thinking}</b></span>` +
    `<span>${n} message${n === 1 ? '' : 's'}</span>` +
    (cfg.useProxy ? `<span>via ${isLocal() ? 'local' : 'site'} proxy</span>` : '');

  renderTopBar();
}


/* =========================================================
   chat captions
   Instead of dumping the first message ("hi") into the sidebar, we
   derive a short topic. Two stages:
     1. instant local guess, so the row is never just "hi"
     2. once a reply exists, ask the model for a 3-6 word caption
   ========================================================= */
const STOP_WORDS = new Set(('a an the and or but if then than that this these those there here of in on at to for from ' +
  'with without about into over under again further is are was were be been being am do does did doing have has had ' +
  'having i me my we our you your he she it its they them their what which who whom how why when where can could ' +
  'will would shall should may might must please help me tell explain give show write make just like want need ' +
  'hi hey hello thanks thank ok okay yes no sure so very really some any').split(' '));

/* filler-only openers shouldn't become a title */
const isSmallTalk = (s) => {
  const w = s.toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return w.length <= 3 && w.every((x) => STOP_WORDS.has(x));
};

function titleCase(s) {
  return s.replace(/\S+/g, (w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .replace(/^./, (m) => m.toUpperCase());
}

/* Stage 1 — cheap, instant, no network. Looks at the whole chat, prefers
   code languages / question topics / most salient keywords. */
function localCaption(c) {
  const text = c.messages.map((m) => m.content || '').join('\n');
  if (!text.trim()) return 'New chat';

  // If the user has only said filler ("hi", "thanks"), the assistant's polite
  // reply would produce nonsense like "Today" — label it plainly instead.
  const asks = c.messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  if (asks.length && asks.every(isSmallTalk)) return 'Greeting';

  // a fenced code block is a strong signal
  const lang = text.match(/```([a-z+#]{2,12})/i);


  // score words across the conversation, favouring the user's asks
  const freq = new Map();
  c.messages.forEach((m) => {
    const weight = m.role === 'user' ? 3 : 1;
    String(m.content || '')
      .replace(/```[\s\S]*?```/g, ' ')            // ignore code
      .replace(/[^A-Za-z0-9+#.\s-]/g, ' ')
      .split(/\s+/)
      .forEach((raw) => {
        const w = raw.replace(/^[-.]+|[-.]+$/g, '');
        const k = w.toLowerCase();
        if (w.length < 3 || w.length > 22 || STOP_WORDS.has(k) || /^\d+$/.test(k)) return;
        freq.set(k, (freq.get(k) || 0) + weight + (/[A-Z]/.test(w[0]) ? 1 : 0));
      });
  });

  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);
  if (!top.length) return lang ? titleCase(lang[1]) + ' snippet' : 'Quick chat';
  const cap = titleCase(top.slice(0, 3).join(' '));
  return (lang ? titleCase(lang[1]) + ': ' + cap : cap).slice(0, 48);
}

/* Stage 2 — ask the model for a real caption (one tiny, non-streaming call). */
async function generateCaption(c) {
  if (!cfg.autoTitle || !cfg.keys[cfg.provider]) return null;
  const transcript = c.messages.slice(0, 4)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + String(m.content || '').slice(0, 700))
    .join('\n\n');
  if (!transcript.trim()) return null;

  const ask = 'Read this conversation and reply with ONLY a short title of 3 to 6 words that '
    + 'describes what it is about. No quotes, no punctuation at the end, no prefix like "Title:".'
    + '\n\n' + transcript;

  const body = cfg.provider === 'anthropic'
    ? { model: cfg.model, max_tokens: 40, messages: [{ role: 'user', content: ask }] }
    : { model: cfg.model, max_tokens: 40, messages: [{ role: 'user', content: ask }] };

  try {
    const res = await fetch(endpoint(), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const j = await readJson(res);
    let out = cfg.provider === 'anthropic'

      ? (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      : (j.choices?.[0]?.message?.content || '');
    if (typeof out !== 'string') return null;
    out = out.trim().split('\n')[0]
      .replace(/^["'`\s]*(title\s*:)?\s*/i, '')
      .replace(/["'`.\s]+$/g, '')
      .slice(0, 52);
    // ignore refusals / junk
    if (!out || out.length < 3 || /^(sure|okay|here)\b/i.test(out)) return null;
    return out;
  } catch { return null; }
}

/* Re-caption a chat: instant local guess, then upgrade via the model. */
async function recaption(c, { force = false } = {}) {
  if (!c || !c.messages.length) return;
  if (c.titleLocked && !force) return;                  // user renamed it manually

  if (force || !c.title || c.title === 'New chat' || c.titleAuto) {
    c.title = localCaption(c);
    c.titleAuto = true;
    saveChats(); renderChatList(); renderTopBar();
  }

  // only spend a call once the assistant has actually answered
  const answered = c.messages.some((m) => m.role === 'assistant' && m.content && !m.error);
  if (!answered || (c.titleModelDone && !force)) return;

  const nice = await generateCaption(c);
  if (nice && chats.some((x) => x.id === c.id)) {
    c.title = nice;
    c.titleAuto = true;
    c.titleModelDone = true;
    saveChats(); renderChatList(); renderTopBar();
  }
}

/* =========================================================
   SSE stream parser (shared by both providers)
   ========================================================= */

async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

/* =========================================================
   send
   ========================================================= */
async function send(text, isRetry = false) {
  if (controller) return;                                  // already streaming
  const key = cfg.keys[cfg.provider];
  if (!key) { openDrawer(); toast('Add your API key first', 'error'); return; }

  const c = ensureChat();

  if (!isRetry) {
    const t = (text ?? $('prompt').value).trim();
    if (!t) return;
    c.messages.push({ role: 'user', content: t, ts: Date.now() });
    // provisional caption only — never the raw first message like "hi".
    if (!c.titleLocked && (!c.title || c.title === 'New chat' || c.titleAuto)) {
      c.title = localCaption(c); c.titleAuto = true;
    }
    $('prompt').value = ''; autoGrow();

    sessionTokens += approxTokens(t);
  }
  c.model = cfg.model; c.provider = cfg.provider; c.ts = Date.now();
  saveChats(); renderChatList(); renderMessages();

  /* placeholder assistant bubble */
  const msg = { role: 'assistant', content: '', thinking: '', model: cfg.model, ts: Date.now() };
  c.messages.push(msg);
  const node = messageNode(msg, c.messages.length - 1);
  const body = node.querySelector('.md');
  body.classList.add('caret');
  $('messages').appendChild(node);
  $('messages').scrollTop = $('messages').scrollHeight;

  controller = new AbortController();
  $('stopBtn').hidden = false; $('sendBtn').disabled = true;
  const t0 = performance.now();
  let usage = null;

  const paint = () => {
    if (msg.thinking && !node.querySelector('details.think')) {
      const d = el('details', 'think');
      d.appendChild(el('summary', null, '🧠 Thinking'));
      d.appendChild(el('div', 'tk', ''));
      node.querySelector('.bub').insertBefore(d, body);
    }
    const tk = node.querySelector('details.think .tk');
    if (tk) { tk.textContent = msg.thinking; tk.scrollTop = tk.scrollHeight; }
    body.innerHTML = MD.render(msg.content);
    const box = $('messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  };

  try {
    const history = c.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const stream = !!cfg.streaming;
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildBody(history, stream)),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(await readError(res));

    if (!stream || !res.body || !(res.headers.get('content-type') || '').includes('event-stream')) {
      /* ---- non-streaming ---- */
      const j = await readJson(res);

      if (cfg.provider === 'anthropic') {
        (j.content || []).forEach((b) => {
          if (b.type === 'thinking') msg.thinking += b.thinking || '';
          else if (b.type === 'text') msg.content += b.text || '';
        });
        if (j.usage) usage = { in: j.usage.input_tokens, out: j.usage.output_tokens };
      } else {
        const ch = j.choices?.[0]?.message || {};
        msg.thinking += ch.reasoning_content || ch.reasoning || '';
        msg.content += (typeof ch.content === 'string' ? ch.content
          : Array.isArray(ch.content) ? ch.content.map((p) => p.text || '').join('') : '') || '';
        if (j.usage) usage = { in: j.usage.prompt_tokens, out: j.usage.completion_tokens };
      }
      if (!msg.content && !msg.thinking) msg.content = '_(empty response)_';
      paint();
    } else {
      /* ---- streaming ---- */
      let ev = '';
      for await (const line of sseLines(res)) {
        if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let j; try { j = JSON.parse(data); } catch { continue; }

        if (cfg.provider === 'anthropic') {
          const type = j.type || ev;
          if (type === 'content_block_delta') {
            const d = j.delta || {};
            if (d.type === 'thinking_delta') msg.thinking += d.thinking || '';
            else if (d.type === 'text_delta') msg.content += d.text || '';
            else if (typeof d.text === 'string') msg.content += d.text;
          } else if (type === 'message_start' && j.message?.usage) {
            usage = { in: j.message.usage.input_tokens, out: j.message.usage.output_tokens };
          } else if (type === 'message_delta') {
            if (j.usage) usage = Object.assign(usage || {}, { out: j.usage.output_tokens ?? usage?.out });
          } else if (type === 'error') {
            throw new Error(j.error?.message || 'stream error');
          }
        } else {
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const d = j.choices?.[0]?.delta || {};
          msg.thinking += d.reasoning_content || d.reasoning || '';
          if (typeof d.content === 'string') msg.content += d.content;
          else if (Array.isArray(d.content)) msg.content += d.content.map((p) => p.text || '').join('');
          if (j.usage) usage = { in: j.usage.prompt_tokens, out: j.usage.completion_tokens };
        }
        paint();
      }
      if (!msg.content && !msg.thinking) msg.content = '_(empty response)_';
    }

    msg.usage = Object.assign({ ms: Math.round(performance.now() - t0) },
      usage || { out: approxTokens(msg.content + msg.thinking) });
    sessionTokens += (msg.usage.out || 0) || approxTokens(msg.content);
  } catch (e) {
    const aborted = e.name === 'AbortError';
    if (aborted) {
      msg.content += msg.content ? '\n\n_(stopped)_' : '_(stopped)_';
    } else {
      let extra = '';
      if (/Failed to fetch|NetworkError|Load failed/i.test(String(e.message))) {
        if (cfg.useProxy && !(await proxyAlive())) {
          extra = isLocal()
            ? '\n→ The local server is NOT running (nothing answers on '
              + location.origin + ').\n   Start it again: double-click start.bat, '
              + 'or run "python server.py" in the project folder.\n'
              + '   Keep that window open while you chat, then reload this page.'
            : '\n→ This site\'s /proxy endpoint did not respond. If you deployed it, '
              + 'make sure the serverless function is enabled (Vercel/Netlify).';
        } else if (!cfg.useProxy) {
          extra = '\n→ Direct call failed. The relay may be unreachable from your network, '
            + 'or an extension/ad-blocker blocked it.'
            + (isLocal() ? ' You can also tick "Route through proxy" and run: python server.py' : '');

        } else {
          extra = '\n→ Network error reaching the relay. Check the base URL in Settings.';
        }
      }
      msg.error = String(e.message || e) + extra;

    }
  } finally {
    controller = null;
    $('stopBtn').hidden = true; $('sendBtn').disabled = false;
    body.classList.remove('caret');
    saveChats();
    renderMessages();
    renderChatList();
    $('prompt').focus();
    // now that we know what the chat is about, give it a real caption
    recaption(c);
  }
}


/* =========================================================
   settings <-> UI
   ========================================================= */
function fillSettings() {
  $('provider').value = cfg.provider;
  $('keyLabel').textContent = cfg.provider === 'anthropic' ? 'Anthropic API Key' : 'OpenAI / Router API Key';
  $('apiKey').value = cfg.keys[cfg.provider] || '';
  $('useCustomBase').checked = !!cfg.useCustomBase;
  $('baseUrl').value = cfg.baseUrl;
  $('baseUrl').disabled = !cfg.useCustomBase;
  $('thinking').value = cfg.thinking;
  $('maxTokens').value = cfg.maxTokens;
  $('temperature').value = cfg.temperature;
  $('systemPrompt').value = cfg.systemPrompt;
  $('autoTitle').checked = !!cfg.autoTitle;
  $('streaming').checked = !!cfg.streaming;
  $('useProxy').checked = !!cfg.useProxy;

  const cs = $('client');
  if (!cs.options.length) {
    Object.entries(CLIENTS).forEach(([k, v]) => {
      const o = el('option', null, v.label); o.value = k; cs.appendChild(o);
    });
  }
  cs.value = cfg.client in CLIENTS ? cfg.client : 'claude-code';
  renderModelSelect(); renderFavChips(); updateMeta();
}

function setModel(m) {
  cfg.model = m;
  if (!cfg.models.includes(m)) cfg.models.push(m);
  saveCfg(); renderModelSelect(); renderFavChips(); updateMeta();
}


/* ---- settings drawer open / close ---------------------------------- */
function openDrawer() {
  fillSettings();
  document.body.classList.add('settings-open');
  $('drawer').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('apiKey').focus({ preventScroll: true }), 220);
}
function closeDrawer() {
  document.body.classList.remove('settings-open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('prompt').focus({ preventScroll: true });
}
const isDrawerOpen = () => document.body.classList.contains('settings-open');
const toggleDrawer = () => (isDrawerOpen() ? closeDrawer() : openDrawer());
const closeSidebar = () => $('sidebar').classList.remove('open');


function autoGrow() {
  const t = $('prompt');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

/* running from a local python server vs. a deployed site? */
const isLocal = () => location.protocol === 'file:'
  || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);

/* ---- is the proxy (server.py locally, edge function in prod) alive? ---- */
async function proxyAlive() {

  if (location.protocol === 'file:') return false;
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

/* Shows a red banner whenever the local server is down, so you know
   before you send a message (this is what "Failed to fetch" means). */
async function checkServer(quiet = true) {
  const bar = $('offline');
  // Direct mode doesn't use /proxy at all, so its status is irrelevant.
  if (!cfg.useProxy) { bar.hidden = true; return true; }
  if (location.protocol === 'file:') {

    bar.hidden = false;
    bar.textContent = '⚠ Opened as a file:// page — the proxy is unavailable. Run "python server.py" and open http://127.0.0.1:8000/';
    return false;
  }
  const ok = await proxyAlive();
  bar.hidden = ok;
  if (!ok) {
    bar.textContent = isLocal()
      ? '⚠ Local server is not running — messages will fail. Double-click start.bat (or run "python server.py") and keep that window open. This banner clears itself.'
      : '⚠ The /proxy service on this site is not responding — messages may fail. If this persists, the serverless function may still be deploying.';
    if (!quiet) toast('Proxy is not responding', 'error');
  }
  return ok;

}


async function fetchModels() {
  const btn = $('fetchModelsBtn'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '…loading';
  try {
    const res = await fetch(modelsUrl(), { headers: authHeaders() });
    if (!res.ok) throw new Error(await readError(res));
    const j = await readJson(res);
    const ids = (j.data || j.models || j || [])

      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    if (!ids.length) throw new Error('No models returned by the server.');
    cfg.models = Array.from(new Set([...ids])).sort();
    if (!cfg.models.includes(cfg.model)) cfg.model = cfg.models[0];
    saveCfg(); renderModelSelect(); renderFavChips(); updateMeta();
    toast(`Loaded ${ids.length} models`, 'ok');

  } catch (e) {
    toast('Could not fetch models: ' + (e.message || e), 'error');
  } finally { btn.disabled = false; btn.textContent = old; }
}

async function testConnection() {
  const btn = $('testBtn'); const old = btn.textContent;
  if (!cfg.keys[cfg.provider]) { toast('Enter an API key first', 'error'); return; }
  btn.disabled = true; btn.textContent = '…testing';
  try {
    const res = await fetch(endpoint(), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(cfg.provider === 'anthropic'
        ? { model: cfg.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
        : { model: cfg.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (!res.ok) throw new Error(await readError(res));
    await readJson(res);
    toast('Connection OK — ' + cfg.model, 'ok');

  } catch (e) {
    toast('Failed: ' + (e.message || e), 'error');
  } finally { btn.disabled = false; btn.textContent = old; }
}

function exportChat() {
  const c = chat();
  if (!c || !c.messages.length) { toast('Nothing to export', 'error'); return; }
  const md = [`# ${c.title}`, `*model: ${c.model} · ${new Date(c.ts).toLocaleString()}*`, '']
    .concat(c.messages.map((m) => `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${m.content}`))
    .join('\n\n');
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = (c.title || 'chat').replace(/[^\w -]+/g, '_').slice(0, 50) + '.md';
  a.click(); URL.revokeObjectURL(a.href);
}

/* =========================================================
   wiring
   ========================================================= */
function bind() {
  // composer
  $('sendBtn').onclick = () => send();
  $('stopBtn').onclick = () => controller?.abort();
  $('prompt').addEventListener('input', autoGrow);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // chats
  $('newChatBtn').onclick = () => {
    const c = { id: uid(), title: 'New chat', model: cfg.model, provider: cfg.provider, ts: Date.now(), messages: [] };
    chats.unshift(c); currentId = c.id; saveChats(); renderChatList(); renderMessages(); closeSidebar(); $('prompt').focus();
  };
  $('exportBtn').onclick = exportChat;
  $('menuBtn').onclick = () => $('sidebar').classList.toggle('open');

  // drawer — sidebar gear toggles it, ✕ / backdrop / Esc close it
  $('settingsBtn2').onclick = () => { closeSidebar(); toggleDrawer(); };

  $('closeDrawer').onclick = (e) => { e.preventDefault(); closeDrawer(); };
  $('backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer(); closeSidebar(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });


  // theme
  $('themeBtn').onclick = () => {
    cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cfg.theme;
    $('themeBtn').textContent = cfg.theme === 'dark' ? '🌙' : '☀';
    saveCfg();
  };

  // settings fields
  $('provider').onchange = (e) => {
    cfg.provider = e.target.value;
    if (!cfg.models.includes(cfg.model)) cfg.model = cfg.models[0];
    saveCfg(); fillSettings();
  };
  $('apiKey').oninput = (e) => { cfg.keys[cfg.provider] = e.target.value.trim(); saveCfg(); };
  $('showKey').onclick = () => {
    const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password';
  };
  $('useCustomBase').onchange = (e) => { cfg.useCustomBase = e.target.checked; saveCfg(); fillSettings(); };
  $('baseUrl').oninput = (e) => { cfg.baseUrl = e.target.value.trim(); saveCfg(); updateMeta(); };
  $('modelSelect').onchange = (e) => setModel(e.target.value);
  $('addModelBtn').onclick = () => {
    const v = $('newModel').value.trim();
    if (!v) return;
    setModel(v); $('newModel').value = '';
    toast('Added ' + v, 'ok');
  };
  $('newModel').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addModelBtn').click(); });
  $('starBtn').onclick = () => {
    const m = cfg.model;
    cfg.favorites = cfg.favorites.includes(m) ? cfg.favorites.filter((x) => x !== m) : [...cfg.favorites, m];
    saveCfg(); renderFavChips();
  };
  $('fetchModelsBtn').onclick = fetchModels;

  $('thinking').onchange = (e) => { cfg.thinking = e.target.value; saveCfg(); updateMeta(); };
  $('maxTokens').oninput = (e) => { cfg.maxTokens = +e.target.value || 8192; saveCfg(); };
  $('temperature').oninput = (e) => { cfg.temperature = +e.target.value; saveCfg(); };
  $('systemPrompt').oninput = (e) => { cfg.systemPrompt = e.target.value; saveCfg(); };
  $('client').onchange = (e) => {
    cfg.client = e.target.value; saveCfg();
    // Direct mode can't set User-Agent, but the `originator` header is what
    // AgentRouter actually checks — so it still works without the proxy.
    if (!cfg.useProxy && cfg.client !== 'codex' && cfg.client !== 'browser') {
      toast('Direct mode: "Codex / OpenAI CLI" is the identity this relay accepts', 'error');
    }
  };

  $('autoTitle').onchange = (e) => { cfg.autoTitle = e.target.checked; saveCfg(); };
  $('streaming').onchange = (e) => { cfg.streaming = e.target.checked; saveCfg(); };


  $('useProxy').onchange = (e) => { cfg.useProxy = e.target.checked; saveCfg(); updateMeta(); };
  $('testBtn').onclick = testConnection;
  $('resetBtn').onclick = () => {
    if (!confirm('Reset all settings (keys included)? Chats are kept.')) return;
    cfg = structuredClone(DEFAULTS); saveCfg(); document.documentElement.dataset.theme = cfg.theme; fillSettings();
    toast('Settings reset', 'ok');
  };
}

/* ---------------- boot ---------------- */
(function init() {
  document.documentElement.dataset.theme = cfg.theme || 'dark';
  $('themeBtn').textContent = cfg.theme === 'light' ? '☀' : '🌙';
  bind();
  fillSettings();          // populate fields without opening the panel

  /* Migrate chats saved by older versions, whose title was just a copy of
     the first message (e.g. "hi"). Give them a real caption instead. */
  chats.forEach((c) => {
    if (!c.messages || !c.messages.length || c.titleLocked) return;
    const first = String(c.messages[0].content || '').trim();
    const looksRaw = !c.title || c.title === 'New chat'
      || first.slice(0, 42) === String(c.title).replace(/…$/, '');
    if (looksRaw) { c.title = localCaption(c); c.titleAuto = true; }
  });
  saveChats();

  renderChatList();

  renderMessages();
  autoGrow();
  closeDrawer();           // start closed: only the ⚙ button shows in the top bar
  // No API key yet? Nudge toward Settings instead of covering the page.
  if (!cfg.keys[cfg.provider]) {
    setTimeout(() => toast('Click ⚙ Settings to add your AgentRouter API key'), 600);
  }
  $('prompt').focus({ preventScroll: true });

  // Is server.py alive? Show a banner if not, and keep re-checking so the
  // banner disappears by itself once you restart it.
  checkServer();
  setInterval(() => { if (!controller) checkServer(); }, 5000);
  window.addEventListener('online', () => checkServer());
})();



