# 🎓 Try and Learn

A single-page chat UI for your **own** GPT / Claude models through [AgentRouter](https://agentrouter.org/)
(or any OpenAI-/Anthropic-compatible relay). Your API key and chats stay in your browser.

Two modes:

* **💬 Chat** — a normal assistant, with image attachments and streamed replies.
* **🛠 Build** — a v0/Bolt-style workspace. Describe an app, watch the model write
  the files, and see it **running live** next to the conversation. Keep prompting
  to refine it, then download the whole thing as a `.zip`.



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
> **“Route through proxy”** in Settings. That works with AgentRouter (it sends CORS
> headers), though running `server.py` is the smoother path locally.


## Deploy it publicly (free)

Visitors bring their **own** API key — nothing is stored on the server, so hosting
costs you nothing and there is no shared key to leak.

Deployed pages run in **direct mode**: the browser talks to AgentRouter itself. That is
set automatically on the first visit, and it's the mode that actually works — see below.

### Vercel / Netlify / GitHub Pages

Any static host works.

- **Vercel** — <https://vercel.com/new> → import the repo → **Deploy**. No build step, no env vars.
- **Netlify** — <https://app.netlify.com/start> → pick the repo → **Deploy**.
- **GitHub Pages** — Settings → Pages → deploy from `main`.

`api/proxy.js` (Vercel) and `netlify/edge-functions/proxy.js` (Netlify) are included as an
optional fallback, but they are **not** the default in production, for the reason below.

### ⚠ Why hosted builds use direct mode

AgentRouter sits behind Aliyun's WAF. Measured behaviour:

| Caller | Result |
|---|---|
| Your own machine / a visitor's browser | ✅ normal JSON |
| A serverless proxy (Vercel/Netlify datacenter IP) | ❌ HTML anti-bot page → *“Unexpected token `<`”* |

So a server-side proxy is the one thing that *cannot* reach it from the cloud. Luckily the
relay sends `Access-Control-Allow-Origin: *`, so the browser may call it directly, and the
client check is satisfied by the `originator` header (which browsers *are* allowed to set).
Direct mode also means your visitors' keys never touch any server.

If a hosted page ever shows a firewall/HTML error, open **Settings** and confirm
*“Route through proxy”* is **unticked**.


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

**With the proxy ON** (local): browsers forbid JavaScript from setting `User-Agent`, so the
page sends the desired identity to `server.py` (`x-ar-ua` / `x-ar-extra`) and the proxy
applies it to the real upstream request — those helper headers are never forwarded.

**In direct mode** (hosted): pick **Codex / OpenAI CLI**. `User-Agent` can't be set, but
AgentRouter's check is satisfied by the `originator` header, which browsers *may* send —
verified working for both `claude-*` and `gpt-*` models.



## Choosing models

The active model is shown under the chat title in the top bar. Manage models inside
**Settings**, where your **pinned** models appear as coloured quick-pick chips
(`✳ claude-opus-4-8`, `✳ claude-opus-5`, `◎ gpt-5.6-sol`) — one click switches model.

- Add a model: Settings → type the id → **＋**
- Pin / unpin: select it, then press **★** (remove with the ✕ on a chip)
- Discover ids from your relay: **↻ Fetch models from server**


Icons and colours are chosen automatically from the model name
(opus/sonnet/haiku → orange ✳, gpt/o-series → green ◎, gemini → blue ✦, …).

## Sidebar

| Item | Does |
|---|---|
| **✎ New chat** | starts a fresh conversation (each keeps its own build project) |
| **🔍 Search** | filters by caption **and** message text — `Ctrl/Cmd+K`, `Enter` opens the top hit, `Esc` closes |
| **📌 Pinned** | jumps to your pinned chats; click again to leave the filter. The badge counts them |
| **🕒 Recents** | clears search + pin filters and scrolls back to the top |

Pin any chat by hovering it and pressing **📍** (a pinned row keeps its 📌 marker
visible, so you can tell at a glance). Pinned chats are grouped above **Recents**.
The button at the top-right of the logo collapses the sidebar to an icon-only
rail — labels come back as hover tooltips, and the state is remembered.

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

## 🛠 Build mode

Flip the sidebar switch to **Build** and the screen splits: conversation on the
left, a live workspace on the right.

```
You:  Build a landing page for an on-chain lottery. Dark theme, amber accents.
      → files appear and the page renders as it's written
You:  Make the hero taller and add a countdown to the next draw.
      → only the changed files are rewritten; the preview refreshes
```

| Control | Does |
|---|---|
| **👁 Preview** | the project running in a sandboxed iframe |
| **`</>` Code** | file tree + source, with per-file **Copy** / **Save** |
| **↻** | re-render the preview |
| **⇗** | open the result in its own browser tab |
| **⤓** | download every file as a `.zip` |

How it works: the model is asked to emit whole files in fences tagged
` ```file:index.html `. Those blocks are pulled out into a virtual file system
stored **on the chat** (so it's saved and restored with the conversation), and
`index.html` is assembled into one self-contained document — sibling
`<link>`/`<script src>` references are inlined, because an iframe can't fetch
files that only exist in memory. Runtime errors surface in a red strip at the
bottom of the preview instead of a console you'd never open.

The transcript stays readable: each written file collapses to a
`📄 index.html · 214 lines written` line, and a “Task 2 of 4” bar tracks the
model's own checklist. Every follow-up prompt resends the current files, so
edits build on what is actually there rather than on the model's memory.

Notes: it's a **static** sandbox — plain HTML/CSS/JS, no npm, no build step, no
JSX (CDN `<script>` tags like Tailwind are fine). Each chat keeps its own
project, so start a new chat for a new app.

## Features


- Streaming (SSE) for both API formats, with **Stop** mid-generation
- **Image input** — click **＋** (left of the input box), paste, or drag images in; they're

  downscaled to ≤1400px before sending, so you don't burn tokens on a 12 MP photo.
  Works with both API shapes (Anthropic blocks / OpenAI `image_url`)
- **Build mode** with live preview and zip export (above)
- Extended **thinking / reasoning** shown in a collapsible “🧠 Thinking” block
- Markdown rendering: headings, lists, tables, quotes, code blocks with **Copy**
- Multi-chat sidebar with auto titles, delete, and Markdown export (⤓)
- Per-message Copy / Edit / Retry / Delete, token + tok/s stats
- Dark & light theme, mobile responsive
- Keyboard: `Enter` send · `Shift+Enter` newline · `Esc` close panels


## Files

```
index.html    markup / settings drawer / build workspace
styles.css    theme, chips, bubbles, workspace, responsive layout
markdown.js   dependency-free Markdown → safe HTML
app.js        state, settings, requests, SSE streaming, image attachments
build.js      build mode: file parser, virtual FS, live preview, zip export
server.py     static server + streaming CORS proxy (stdlib only)
start.bat     double-click launcher (Windows)
```


## Where your data lives

There is **no server-side storage** — no accounts, no database, no logging. Everything a
visitor types stays in their own browser's `localStorage`, under two keys
(`ar.cfg.v1` for settings, `ar.chats.v1` for chats).

| | Stored where | Removed when |
|---|---|---|
| API key | your browser only | you press 🗑 next to the key, use **Erase everything**, clear site data, or untick *Remember my API key* (then it's forgotten when the tab closes) |
| Chats | your browser only | delete a chat, press **Erase everything**, or clear site data |
| Settings | your browser only | **Reset settings**, **Erase everything**, or clear site data |

Because storage is per-browser and per-device, each visitor only ever sees their own key
and their own chats — one person's data can never appear for someone else. In direct mode
(the default on hosted sites) the key is sent **only** to the relay you configured; it
never passes through the site's own server.

Two things worth knowing: `localStorage` is **not encrypted**, so anyone with access to
your device or your browser's devtools can read a remembered key — untick *Remember my
API key* on shared computers. And a key stays valid until you revoke it in AgentRouter,
so if you suspect it leaked, rotate it there.

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
