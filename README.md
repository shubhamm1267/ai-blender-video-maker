# Text-to-Video Generator + Prompt Ideas

Full-stack app with **two pages**, one backend, one startup command:

| Page | Route | What it does | Powered by |
|---|---|---|---|
| **Text → Video** | `/#/video` | Turns a prompt into an AI-generated video | [Agnes AI](https://platform.agnes-ai.com/) `agnes-video-v2.0` + local FFmpeg finishing |
| **Prompt Ideas** | `/#/prompt` | Writes a fresh "oddly satisfying" 3D animation prompt | Google Gemini |

The two pages are connected: generate an idea on **Prompt Ideas**, click
**Use for video →**, and it drops straight into the video page's textarea.

- **Frontend:** Angular 17 (standalone components + router) — dark card UI.
- **Backend:** Node.js + Express — Agnes AI video jobs *and* Gemini prompt generation.

---


## Physics + permanent channel watermark (v2)

This update has two layers:

1. **Physics-directed prompting:** every video request is wrapped with a
   physics specification covering gravity, friction, traction, inertia,
   collisions, momentum, continuous contact, temporal consistency, rolling
   without slipping where appropriate, and no floating/teleporting/clipping.
   This improves the model's physical coherence, but Agnes remains a
   generative video model rather than a deterministic physics simulator.
2. **Permanent watermark:** after Agnes finishes, the backend downloads the
   generated MP4 and uses the locally installed `ffmpeg-static` binary to
   burn `MarbleVortex3D` into the bottom-right corner. The final MP4 therefore
   contains the watermark even when the video model ignores prompt text.

You can change the channel name in `backend/.env`:

```
CHANNEL_WATERMARK=MarbleVortex3D
WATERMARK_OPACITY=0.72
```

The app's **Download Final Video** downloads the post-processed MP4, not the
raw Agnes output.

## 1. API keys

Both keys live in `backend/.env`. Neither ever reaches the browser.

```
AGNES_API_KEY=sk-xxxxxxxxxxxxxxxx      # https://platform.agnes-ai.com/
GEMINI_API_KEY=AQ.xxxxxxxxxxxxxxxx     # https://aistudio.google.com/apikey
PORT=3000
```

Each page only needs its own key — the video page works without a Gemini key,
and vice versa.

## 2. Run it

On Windows, double-click (or run):

```
start.bat
```

First run installs dependencies (root, `backend/`, `frontend/`), then starts
both servers in the same window:

- Backend → http://localhost:3000
- Text → Video → http://localhost:4200/#/video
- Prompt Ideas → http://localhost:4200/#/prompt

`Ctrl+C` in that window stops both.

### Manual start (macOS/Linux)

```bash
npm run install:all
npm run dev
```

---

## Gemini keys: the "check your API key" trap

Google changed the AI Studio key format. Old keys start with `AIza...`, new
ones start with `AQ.`. Older versions of `@google/genai` can't authenticate the
new `AQ.` keys and return `401 ACCESS_TOKEN_TYPE_UNSUPPORTED` — which looks
exactly like a wrong key even when the key is perfectly valid.

This project uses `@google/genai` v2 and sends the key as an `x-goog-api-key`
header, which is what `AQ.` keys expect. If you hit a key problem, test it
directly instead of guessing:

```bash
npm run check-key --prefix backend
```

| Result | Meaning | Fix |
|---|---|---|
| `Key works` | all good | run `start.bat` |
| `401` | the key itself is rejected | regenerate at https://aistudio.google.com/apikey |
| `403` | key fine, API not enabled | enable "Generative Language API" in Google Cloud, or use a fresh project |
| `429` | quota / rate limit | wait a minute, or check billing |
| `NETWORK ERROR` | never reached Google | check internet, VPN, firewall |

While the backend is running:

- `GET /api/prompt/health` — is the Gemini key loaded, and what format is it?
- `GET /api/prompt/models` — which models this key can actually use

---

## API routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/generate` | Start a video job → `{ jobId, status }` |
| `GET` | `/api/status/:jobId` | Poll a video job |
| `POST` | `/api/prompt/generate` | Get one new prompt idea → `{ prompt, model }` |
| `GET` | `/api/prompt/health` | Gemini key diagnostics |
| `GET` | `/api/prompt/models` | Models available to your key |
| `GET` | `/api/prompt/system-instruction` | The prompt-writing rules, as plain text |

The prompt routes are namespaced under `/api/prompt` so they never collide
with `/api/generate`, which the video page already owns.

## How the video page works

1. The frontend posts your prompt to `POST /api/generate`.
2. The backend creates an async video task on Agnes AI and returns a local
   `jobId` immediately.
3. The frontend polls `GET /api/status/:jobId` every 3 seconds. The backend
   normalizes Agnes AI's status to `pending → processing → completed → failed`.
4. Once `completed`, the `<video>` player loads the URL and **Download Video**
   becomes available.

## Notes & limits

- **Agnes rate limit:** the free plan allows ~1 video request per minute.
  Creation *and* status polling share that budget, so the backend throttles its
  own Agnes checks to every 20s while the frontend keeps polling every 3s.
- **Timeout:** a job that hasn't completed in 5 minutes is marked failed
  (enforced both server-side and client-side).
- **Jobs are in-memory:** restarting the backend clears in-progress jobs. Swap
  the `Map` in `server.js` for a database if you need persistence.
- **Model fallback:** `backend/gemini.js` tries several Gemini model names in
  order, so a retired model name doesn't take the page down.

## Project structure

```
project-root/
├── start.bat                    # one-command startup (Windows)
├── package.json                 # root scripts + concurrently
├── backend/
│   ├── server.js                # Express app, video routes, mounts prompt routes
│   ├── agnes-video.js           # Agnes AI client (create + poll)
│   ├── prompt-routes.js         # /api/prompt/* router
│   ├── gemini.js                # prompt rules, model fallback, error handling
│   ├── check-key.js             # Gemini key diagnostic
│   ├── .env                     # both API keys (fill this in)
│   └── .env.example
└── frontend/src/app/
    ├── app.component.*          # nav bar + router outlet
    ├── app.routes.ts            # /video and /prompt
    ├── shared/
    │   └── prompt-bridge.service.ts   # hands a prompt from one page to the other
    ├── generator/               # Text → Video page
    │   ├── generator.component.*
    │   └── generation.service.ts
    └── prompt/                  # Prompt Ideas page
        ├── prompt.component.*
        └── prompt.service.ts
```

## Editing the prompt style

The rules Gemini follows (physics, looping, camera, lighting, the
`MarbleVortex3D` watermark line, length) live in `SYSTEM_INSTRUCTION` at the
top of `backend/gemini.js`. Edit it and restart the backend.
