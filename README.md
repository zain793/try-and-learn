# 🎓 Try and Learn

A single-page chat UI for your **own** GPT / Claude models through [AgentRouter](https://agentrouter.org/)
(or any OpenAI-/Anthropic-compatible relay). Your API key and chats stay in your browser.


![chips](https://img.shields.io/badge/models-claude--opus--5%20%C2%B7%20gpt--5.6--sol-blue)

## Run it

Double-click **`start.bat`** — it launches the server and opens the page.
**Keep that window open while you chat.** Or manually:

```bash
cd path/to/this/folder
python server.py
```


> ### “Failed to fetch”
> This means the local server isn't running (the window was closed or Ctrl+C'd),
> so the page has nothing to send through. A red banner appears at the top when
> that happens — start `start.bat` again and it clears itself within 5 seconds.


Open <http://127.0.0.1:8000> → click **⚙ Settings** (bottom-left of the sidebar) to add your key. Press **✕** to close it again.



> You can also just double-click `index.html`, but then you must untick
> **“Route through local proxy”** and your relay must allow browser (CORS) calls.
> Running `server.py` is the reliable path.

## Deploy it publicly (free)

Visitors bring their **own** API key — nothing is stored on the server, so hosting
costs you nothing and there is no shared key to leak.

The site needs one tiny serverless function for `/proxy` (browsers can't call the
relay directly: CORS blocks it, and the relay rejects browser `User-Agent`s with
*“unauthorized client detected”*). It's already written for both hosts:

### Vercel (recommended)

1. Push this repo to GitHub (see below).
2. <https://vercel.com/new> → **Import** the repo → **Deploy**. No build step, no env vars.
3. Done — `vercel.json` maps `/proxy` and `/health` to `api/proxy.js` / `api/health.js`.

### Netlify

<https://app.netlify.com/start> → pick the repo → **Deploy**.
`netlify.toml` wires both paths to `netlify/edge-functions/proxy.js`.

> ### ⚠ GitHub Pages won't fully work
> Pages serves static files only — there is no `/proxy`, so requests fail with CORS or
> a 401. Visitors would have to untick *“Route through local proxy”* **and** use a relay
> that allows browser calls. Use Vercel or Netlify instead.

### Push to GitHub

```bash
git init -b main
git add -A
git commit -m "Try and Learn — bring-your-own-key chat UI"
git remote add origin https://github.com/<you>/try-and-learn.git
git push -u origin main
```

## Settings (mirrors the panel in your screenshot)


| Field | What to put |
|---|---|
| **API Provider** | `Anthropic` for `claude-*` models · `OpenAI compatible` for `gpt-*`, `o*` |
| **API Key** | the key you generated in AgentRouter (stored only in `localStorage`) |
| **Use custom base URL** | ✅ checked, with `https://agentrouter.org/` |
| **Model** | pick from the list, or type any id and press **＋** |
| **Client identity** | `Claude Code CLI` for `claude-*` · `Codex / OpenAI CLI` for `gpt-*` (see below) |
| **Adaptive Thinking** | `None` disables it · `Low → Xhigh` raises reasoning effort/tokens |
| **Max output tokens / Temperature** | per-request limits |
| **System prompt** | persona / instructions sent with every message |


The endpoint is built for you:

```
Anthropic  →  https://agentrouter.org/v1/messages
OpenAI     →  https://agentrouter.org/v1/chat/completions
```

Press **✓ Test connection** to verify the key + model before chatting.

## “unauthorized client detected” (HTTP 401)

If you see this, **your key is fine** — the relay rejected the *client*. AgentRouter
inspects the `User-Agent` / client headers and only serves requests that look like an
official CLI (Claude Code, Codex), not a random browser page.

Fix: **Settings → Client identity**

| Model family | Choose |
|---|---|
| `claude-*` | **Claude Code CLI** |
| `gpt-*`, `o*` | **Codex / OpenAI CLI** |
| still refused | try **OpenAI Node SDK** / **OpenAI Python SDK** |

Requirements: **Route through local proxy** must stay ON. Browsers forbid JavaScript
from setting `User-Agent`, so the page sends the desired identity to `server.py`
(`x-ar-ua` / `x-ar-extra`) and the proxy applies it to the real upstream request —
those helper headers are consumed by the proxy and never forwarded.


## Choosing models

The active model is shown under the chat title in the top bar. Manage models inside
**Settings**, where your **pinned** models appear as coloured quick-pick chips
(`✳ claude-opus-4-8`, `✳ claude-opus-5`, `◎ gpt-5.6-sol`) — one click switches model.

- Add a model: Settings → type the id → **＋**
- Pin / unpin: select it, then press **★** (remove with the ✕ on a chip)
- Discover ids from your relay: **↻ Fetch models from server**


Icons and colours are chosen automatically from the model name
(opus/sonnet/haiku → orange ✳, gpt/o-series → green ◎, gemini → blue ✦, …).

## Chat captions

Sidebar rows are **not** the raw first message (a chat starting with “hi” would be
useless to find later). Instead each row gets a topic caption plus a second line
showing when it happened and how many messages it has:

1. **Instantly** — a local keyword pass over the whole conversation, weighted toward
   your questions, with code-fence languages detected (`Javascript: Fix Missing Semicolon`).
   Filler-only chats become `Greeting` rather than a random word.
2. **After the first reply** — the model writes a proper 3–6 word caption
   (one small request, once per chat).

| Action | How |
|---|---|
| Rename manually | hover a row → **✎** (locked afterwards; auto-naming leaves it alone) |
| Back to automatic | **✎** → clear the box → OK |
| Regenerate caption | hover a row → **↻** |
| Turn AI naming off | Settings → *Name chats automatically* (local captions still apply) |

## Features


- Streaming (SSE) for both API formats, with **Stop** mid-generation
- Extended **thinking / reasoning** shown in a collapsible “🧠 Thinking” block
- Markdown rendering: headings, lists, tables, quotes, code blocks with **Copy**
- Multi-chat sidebar with auto titles, delete, and Markdown export (⤓)
- Per-message Copy / Edit / Retry / Delete, token + tok/s stats
- Dark & light theme, mobile responsive
- Keyboard: `Enter` send · `Shift+Enter` newline · `Esc` close panels

## Files

```
index.html    markup / settings drawer
styles.css    theme, chips, bubbles, responsive layout
markdown.js   dependency-free Markdown → safe HTML
app.js        state, settings, requests, SSE streaming
server.py     static server + streaming CORS proxy (stdlib only)
start.bat     double-click launcher (Windows)
```

## Notes

- Credits are consumed on your AgentRouter account; the footer of each reply shows
  input/output tokens, elapsed time and tok/s.
- The proxy only forwards to a small allowlist (agentrouter.org, api.anthropic.com,
  api.openai.com, openrouter.ai, …). For another host: `python server.py --allow-any`.
- Anthropic + “Adaptive Thinking” keeps `temperature = 1` (API requirement); switch
  thinking to **None** to control temperature.
- Keys live in `localStorage` on this machine only — clearing site data erases them.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to fetch` | the local server stopped — run `start.bat` again (red banner shows this) |
| `HTTP 401` + *“unauthorized client detected”* | Settings → **Client identity** → `Claude Code CLI` (Claude) or `Codex / OpenAI CLI` (GPT) |
| `HTTP 401` (other) | wrong/expired API key |
| `HTTP 404` | wrong base URL or model id — try **↻ Fetch models** |
| `HTTP 429` | rate limited or out of credits |
| No thinking block | model doesn’t expose reasoning, or thinking = `None` |
