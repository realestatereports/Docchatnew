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

/**
 * Public oEmbed endpoint — gives title and channel without an API key. Used when
 * the watch page was bot-blocked, since we still want to label the source.
 */
async function fetchOEmbedMeta(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || "", channel: data.author_name || "" };
  } catch {
    return null;
  }
}

/**
 * Paid-but-free-tier fallback: Supadata maintains the IP pools needed to reach
 * YouTube from a datacenter, which we cannot do from Vercel. Only called when
 * the direct path is blocked, so local development spends no credits.
 * Docs: https://docs.supadata.ai/get-transcript  (offset/duration are ms)
 */
async function fetchViaSupadata(videoId) {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) return { ok: false, message: null };   // not configured; stay quiet

  const endpoint =
    `https://api.supadata.ai/v1/transcript` +
    `?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}` +
    `&text=false&mode=native&lang=en`;   // without this it returns the video's default track

  try {
    let res = await fetch(endpoint, { headers: { "x-api-key": apiKey } });

    // Long videos can come back as an async job; poll briefly for it.
    if (res.status === 202) {
      const { jobId } = await res.json().catch(() => ({}));
      if (!jobId) return { ok: false, message: "The transcript service returned an unusable job." };
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
          headers: { "x-api-key": apiKey },
        });
        if (!poll.ok) break;
        const body = await poll.json();
        if (body.status === "completed" || Array.isArray(body.content)) { res = null; return shape(body); }
        if (body.status === "failed") {
          return { ok: false, message: "The transcript service could not process that video." };
        }
      }
      return { ok: false, message: "The transcript service took too long. Try again." };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "The transcript service rejected the server's API key." };
    }
    if (res.status === 429) {
      return { ok: false, message: "The transcript service's monthly free quota is used up." };
    }
    if (!res.ok) {
      return { ok: false, message: `The transcript service returned ${res.status}.` };
    }
    return shape(await res.json());
  } catch {
    return { ok: false, message: "Couldn't reach the transcript service." };
  }

  function shape(body) {
    const chunks = Array.isArray(body?.content) ? body.content : [];
    const segments = chunks
      .map((c) => ({
        start: Number(c?.offset ?? 0) / 1000,      // ms → seconds
        text: String(c?.text ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((seg) => Number.isFinite(seg.start) && seg.text.length > 0);

    return segments.length
      ? { ok: true, segments, lang: body?.lang || null }
      : { ok: false, message: "The transcript service returned an empty transcript." };
  }
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
  let player = extractPlayerResponse(html);

  const usable = (p) =>
    !!p &&
    (!p.playabilityStatus?.status || p.playabilityStatus.status === "OK") &&
    Array.isArray(p.captions?.playerCaptionsTracklistRenderer?.captionTracks);

  // Shared server IPs (Vercel, most clouds) are frequently served a bot-check
  // page instead of the real one. The player endpoint uses a different client
  // and often still answers, so try it before giving up.
  let innertube = null;
  if (!usable(player)) {
    innertube = await fetchPlayerViaInnertube(videoId).catch(() => null);
    if (usable(innertube)) player = innertube;
  }

  if (!player) {
    return fail(
      "Couldn't read that video's page — YouTube may have served a consent or bot-check page instead."
    );
  }

  const status = player.playabilityStatus || {};
  if (status.status && status.status !== "OK") {
    const botBlocked = /not a bot|sign in to confirm/i.test(status.reason || "");

    // Blocked as a bot: hand off to the transcript service, if one is configured.
    if (botBlocked) {
      const viaService = await fetchViaSupadata(videoId);
      if (viaService.ok) {
        const meta = (await fetchOEmbedMeta(videoId)) || {};
        return res.status(200).json({
          ok: true,
          videoId,
          title: meta.title || "Untitled video",
          channel: meta.channel || "",
          lang: viaService.lang || null,
          source: "service",
          segments: viaService.segments,
        });
      }
      return fail(
        viaService.message ||
          "YouTube blocked this request as automated traffic, which it does for most requests from shared server IPs. Configure SUPADATA_API_KEY to route around it."
      );
    }

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

  // The page's own baseUrl no longer serves caption data, so prefer the player
  // endpoint's track list — and pick from whichever list we actually fetch from,
  // rather than matching across two lists. The lists differ by requesting IP, and
  // a failed cross-match silently fell through to the first track (Arabic, on a
  // 31-language video), which is how English videos came back in another language.
  let tracks = pageTracks;
  try {
    const alt = innertube || (await fetchPlayerViaInnertube(videoId));
    const altTracks = alt?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(altTracks) && altTracks.length > 0) tracks = altTracks;
  } catch {
    // keep the page's list
  }

  const track = pickBestTrack(tracks);
  if (!track?.baseUrl) {
    return fail(`"${title}" lists caption tracks but none of them can be downloaded.`);
  }

  // --- 4. fetch and parse the timedtext XML ---------------------------------
  // Pin the language and strip `tlang`, so YouTube can't hand back a machine
  // translation of the track we asked for.
  let captionUrl = track.baseUrl;
  try {
    const u = new URL(track.baseUrl);
    u.searchParams.delete("tlang");
    if (track.languageCode) u.searchParams.set("lang", track.languageCode);
    captionUrl = u.toString();
  } catch {
    // non-parseable URL: use it as-is
  }

  let xml;
  try {
    const capRes = await fetch(captionUrl, {
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

  return res.status(200).json({
    ok: true,
    videoId,
    title,
    channel,
    lang: track.languageCode || null,
    source: "direct",
    segments,
  });
}
