import Anthropic from "@anthropic-ai/sdk";

/**
 * ONE endpoint for both modes.
 *
 * POST { question, documentText?, segments?, videoTitle?, history? }
 *   → { answer, truncated, sourceType: "pdf" | "youtube" }
 *
 * Exactly one source field is sent per request: documentText for a PDF,
 * segments for a YouTube video. The only thing that differs downstream is the
 * citation rule.
 */

const client = new Anthropic(); // reads ANTHROPIC_API_KEY — never sent to the client
const MODEL = "claude-sonnet-5";
const MAX_SOURCE_CHARS = 300_000;

/** Transcript prefix format: [M:SS] — minutes are not wrapped at 60. */
function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const BASE_RULES = `You are DocChat. You answer questions about ONE source the user has provided, and nothing else.

Rules:
- Answer ONLY from the source below. Never use outside knowledge and never guess.
- If the source doesn't cover the question, say so plainly in a sentence or two and stop. Do not speculate, and do not pad the answer with adjacent material — say what it does cover instead, briefly.
- Never invent a citation. Every citation must point where the supporting text actually appears.
- Quote only when the exact wording matters.
- Be direct and concise. No preamble, and don't restate the question.`;

const PDF_CITATION_RULE = `CITATION RULE — pages:
- Cite the page for every factual claim, written as (p. 14).
- The source is tagged with [PAGE n] ... [END PAGE n] markers. Use the number from the marker that contains the text you relied on.
- When a claim draws on more than one page, write (p. 3, 7).
- Never emit a timestamp citation for this source.`;

const YOUTUBE_CITATION_RULE = `CITATION RULE — timestamps:
- Cite the moment for every factual claim, written as (12:45).
- Each transcript line is prefixed with its start time as [M:SS]. Cite the timestamp of the line where the supporting words are spoken.
- Copy timestamps exactly as they appear. Do not round them and do not compute a time that has no line.
- When a claim draws on more than one moment, write (2:10, 8:45).
- Never emit a page citation for this source.`;

const TRUNCATION_NOTE = `NOTE: This source was too long to include in full and has been cut off at the point marked below. If the answer would depend on material past that point, say that the source was truncated rather than guessing.`;

/** Normalize prior turns into alternating-safe API messages. */
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: typeof turn?.content === "string" ? turn.content.trim() : "",
    }))
    .filter((turn) => turn.content.length > 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "This endpoint only accepts POST." });
    return;
  }

  const { question, documentText, segments, videoTitle, history } = req.body ?? {};

  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "question is required." });
    return;
  }

  // --- detect the mode from whichever source field is present ---------------
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  const hasDocument = typeof documentText === "string" && documentText.trim().length > 0;

  let sourceType;
  let sourceContent;
  let citationRule;
  let sourceLabel;

  if (hasSegments) {
    sourceType = "youtube";
    citationRule = YOUTUBE_CITATION_RULE;
    sourceLabel = `TRANSCRIPT of the YouTube video "${videoTitle || "Untitled video"}"`;
    sourceContent = segments
      .map((seg) => `[${fmtTime(seg?.start)}] ${String(seg?.text ?? "").trim()}`)
      .filter((line) => line.replace(/^\[[\d:]+\]\s*/, "").length > 0)
      .join("\n");
  } else if (hasDocument) {
    sourceType = "pdf";
    citationRule = PDF_CITATION_RULE;
    sourceLabel = "SOURCE DOCUMENT";
    sourceContent = documentText;
  } else {
    res.status(400).json({
      error: "Provide either documentText (PDF) or a non-empty segments array (YouTube).",
    });
    return;
  }

  // --- truncate over-long sources ------------------------------------------
  let truncated = false;
  if (sourceContent.length > MAX_SOURCE_CHARS) {
    sourceContent = sourceContent.slice(0, MAX_SOURCE_CHARS) + "\n\n[SOURCE TRUNCATED HERE]";
    truncated = true;
  }

  const system = [
    BASE_RULES,
    citationRule,
    truncated ? TRUNCATION_NOTE : null,
    `--- ${sourceLabel} ---\n${sourceContent}\n--- END ${sourceLabel} ---`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [...normalizeHistory(history), { role: "user", content: question.trim() }];

  // Checked after request validation so a malformed request still gets a 400.
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
    return;
  }

  try {
    // Streamed transport, single JSON response: keeps large PDFs from tripping
    // the request timeout without changing the response contract.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // The source is a large, stable prefix — cache it so follow-ups are cheap.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    });

    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      res.status(200).json({
        answer: "I can't answer that request.",
        truncated,
        sourceType,
      });
      return;
    }

    const answer = final.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!answer) {
      res.status(502).json({ error: "The model returned an empty answer. Try rephrasing." });
      return;
    }

    res.status(200).json({ answer, truncated, sourceType });
  } catch (err) {
    const status = Number(err?.status);
    const message =
      status === 429
        ? "Rate limited — wait a moment and try again."
        : status === 401 || status === 403
        ? "The server's API key was rejected."
        : status >= 500
        ? "The model service is having trouble. Try again shortly."
        : err?.message || "Unexpected server error.";
    res.status(status && status < 500 ? status : 502).json({ error: message });
  }
}
