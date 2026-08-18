# DocChat — chat with any PDF or YouTube video

One app, two source modes. Upload a PDF or paste a YouTube URL, then ask questions
that are answered **only** from that source — with page citations for PDFs and
clickable timestamp citations that seek an embedded player for video.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The entire frontend: mode toggle, client-side PDF text extraction via pdf.js, chat UI, and citation rendering (timestamps become clickable spans that reload the embedded player at that second). |
| `api/chat.js` | The one unified chat endpoint. `POST {question, documentText?, segments?, videoTitle?, history?}` → `{answer, truncated, sourceType}`. Detects the mode from whichever source field is present and branches only the citation rule. Sources over 300,000 characters are truncated, flagged in the prompt and in the response. |
| `api/transcript.js` | Server-side YouTube transcript fetcher. `POST {youtubeUrl}` → `{ok, videoId, title, channel, segments}`, or `{ok: false, message}` — it reports failures rather than throwing. |
| `package.json` | Declares the single dependency (`@anthropic-ai/sdk`) and Node 20+. |

## Setup

```bash
npm install
```

Set the API key as an environment variable — it is never referenced in frontend code:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Then run locally with the Vercel CLI (it serves `index.html` and the `api/` functions together):

```bash
npx vercel dev
```

Deploying: `npx vercel deploy`, and add `ANTHROPIC_API_KEY` in the project's
environment variables.

## How grounding works

- **PDF** — pdf.js extracts text in the browser, tagging each page as
  `[PAGE n] … [END PAGE n]`. The file itself never leaves the device; only the
  extracted text is sent. Claude cites `(p. 14)` from those markers.
- **YouTube** — the transcript is fetched server-side once per video and reused
  for every question. Each line is prefixed with its start time as `[M:SS]`, so
  Claude cites `(12:45)` — and the frontend turns each citation into a clickable
  span that reloads the embedded player with `&autoplay=1&start=765`.

  Note: minutes in `[M:SS]` are not wrapped at 60, so a two-hour video cites
  `(127:30)` rather than `(2:07:30)`. The frontend accepts both.

  Caveat worth knowing: the caption `baseUrl` embedded in the watch page now
  returns an empty body, so the endpoint re-resolves the chosen language against
  YouTube's internal player endpoint to get a URL that still serves data. If
  transcripts start failing, that is the first thing to check.

In both modes the system prompt restricts Claude to the provided source and
requires it to say plainly when something isn't covered rather than guess. The
source text is sent with a cache breakpoint, so follow-up questions about the
same PDF or video reuse the cached prefix.

## Requirements

- The video must have captions — there is no audio transcription step.
- Scanned PDFs with no selectable text are rejected up front (no OCR).
