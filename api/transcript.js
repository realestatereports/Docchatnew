/**
 * POST { youtubeUrl } → { ok: true, videoId, title, channel, segments }
 *                     | { ok: false, message }
 *
 * Fetched once per video; the frontend keeps the segments and never re-requests
 * them per question. Every external fetch is wrapped — this endpoint reports
 * failures as ok:false with an honest message and never throws.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/* ---------------------------------- helpers --------------------------------- */

/** Handles /watch?v=, youtu.be/, /embed/, /shorts/, /live/, or a bare 11-char ID. */
function extractVideoId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  const ok = (id) => (/^[\w-]{11}$/.test(id) ? id : null);

  if (host === "youtu.be") return ok(url.pathname.slice(1).split("/")[0]);
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;

  const v = url.searchParams.get("v");
  if (v) return ok(v);

  const m = url.pathname.match(/\/(?:embed|shorts|v|live)\/([^/?#]+)/);
  return m ? ok(m[1]) : null;
}

/**
 * Pull the ytInitialPlayerResponse object out of the page's inline scripts.
 * Brace-matched rather than regex-captured, since the JSON contains both
 * braces and escaped quotes inside string values.
 */
function extractPlayerResponse(html) {
  const anchor = html.indexOf("ytInitialPlayerResponse");
  if (anchor === -1) return null;

  const start = html.indexOf("{", anchor);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Ask YouTube's internal player endpoint for the same video.
 *
 * Why this exists: the caption `baseUrl` embedded in the watch page now returns
 * HTTP 200 with an empty body for every format variant. The URL from this
 * endpoint still serves caption data, so we take the track list and metadata
 * from the page (per the scraping path above) and the fetchable URL from here.
 */
async function fetchPlayerViaInnertube(videoId) {
  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
        "Accept-Language": "en-US,en",
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 34,
            hl: "en",
            gl: "US",
          },
        },
      }),
    }
  );
  if (!res.ok) return null;
  return res.json();
}

/** Manually-created English → auto-generated English → first available. */
function pickBestTrack(tracks) {
  const isEnglish = (t) => (t.languageCode || "").toLowerCase().startsWith("en");
  return (
    tracks.find((t) => isEnglish(t) && t.kind !== "asr") ||
    tracks.find((t) => isEnglish(t) && t.kind === "asr") ||
    tracks[0] ||
    null
  );
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

function decodeEntities(text) {
  let out = String(text);
  // timedtext double-escapes (e.g. "&amp;#39;"), so decode twice.
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
      const key = body.toLowerCase();
      if (NAMED_ENTITIES[key] !== undefined) return NAMED_ENTITIES[key];
      if (key.startsWith("#x")) {
        const code = parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith("#")) {
        const code = parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    });
  }
  return out;
}

/**
 * Parse a timedtext response into {start: seconds, text}.
 *
 * Two markup shapes exist in the wild and we accept both:
 *   legacy  <text start="12.3" dur="4.5">…</text>   — start in SECONDS
 *   format3 <p t="12300" d="4500">…</p>             — start in MILLISECONDS
 */
function parseTimedText(xml) {
  const shapes = [
    { re: /<text\b([^>]*)>([\s\S]*?)<\/text>/g, attr: "start", scale: 1 },
    { re: /<p\b([^>]*)>([\s\S]*?)<\/p>/g, attr: "t", scale: 0.001 },
  ];

  for (const { re, attr, scale } of shapes) {
    const segments = [];
    let match;

    while ((match = re.exec(xml)) !== null) {
      const [, attrs, body] = match;
      const rawStart = attrs.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1];
      const start = Number(rawStart) * scale;
      if (!Number.isFinite(start)) continue;

      const text = decodeEntities(body)
        .replace(/<[^>]+>/g, "")   // inline tags, incl. per-word <s> in auto-captions
        .replace(/\s+/g, " ")
        .trim();

      if (!text) continue;          // drop empty (timing-only) entries
      segments.push({ start, text });
    }

    if (segments.length > 0) return segments;
  }
  return [];
}

/* ---------------------------------- handler --------------------------------- */

export default async function handler(req, res) {
  const fail = (message, status = 200) => res.status(status).json({ ok: false, message });

  if (req.method !== "POST") {
    return fail("This endpoint only accepts POST.", 405);
  }

  const videoId = extractVideoId(req.body?.youtubeUrl);
  if (!videoId) {
    return fail("That doesn't look like a YouTube URL — check the link and try again.");
  }

  // --- 1. fetch the watch page -----------------------------------------------
  let html;
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!pageRes.ok) {
      return fail(
        pageRes.status === 404
          ? "That video doesn't exist — it may have been deleted."
          : `YouTube returned ${pageRes.status} for that video. Try again in a moment.`
      );
    }
    html = await pageRes.text();
  } catch {
    return fail("Couldn't reach YouTube. Check the connection and try again.");
  }

  // --- 2. parse the embedded player response ---------------------------------
  const player = extractPlayerResponse(html);
  if (!player) {
    return fail(
      "Couldn't read that video's page — YouTube may have served a consent or bot-check page instead."
    );
  }

  const status = player.playabilityStatus || {};
  if (status.status && status.status !== "OK") {
    return fail(
      status.reason ||
        "That video can't be read — it may be private, age-restricted, or region-blocked."
    );
  }

  const details = player.videoDetails || {};
  const title = details.title || "Untitled video";
  const channel = details.author || "";

  // --- 3. pick a caption track ----------------------------------------------
  const pageTracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(pageTracks) || pageTracks.length === 0) {
    return fail(`"${title}" has no captions, so there's no transcript to read.`);
  }

  // The page's own baseUrl no longer serves caption data, so re-resolve the
  // chosen language against the player endpoint, which still does.
  const chosen = pickBestTrack(pageTracks);
  let track = null;
  try {
    const alt = await fetchPlayerViaInnertube(videoId);
    const altTracks = alt?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(altTracks) && altTracks.length > 0) {
      track =
        altTracks.find(
          (t) => t.languageCode === chosen?.languageCode && t.kind === chosen?.kind
        ) ||
        altTracks.find((t) => t.languageCode === chosen?.languageCode) ||
        pickBestTrack(altTracks);
    }
  } catch {
    // fall through to the page's track below
  }

  track = track || chosen;
  if (!track?.baseUrl) {
    return fail(`"${title}" lists caption tracks but none of them can be downloaded.`);
  }

  // --- 4. fetch and parse the timedtext XML ---------------------------------
  let xml;
  try {
    const capRes = await fetch(track.baseUrl, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!capRes.ok) {
      return fail(`Couldn't download the captions (YouTube returned ${capRes.status}).`);
    }
    xml = await capRes.text();
  } catch {
    return fail("Couldn't download the captions for that video. Try again in a moment.");
  }

  const segments = parseTimedText(xml);
  if (segments.length === 0) {
    return fail(`The caption track for "${title}" came back empty.`);
  }

  return res.status(200).json({ ok: true, videoId, title, channel, segments });
}
