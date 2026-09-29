// Cloudflare Pages Function: POST /api/tutor
// Keeps your Anthropic API key on the server and forwards tutor questions.
//
// Settings (Cloudflare dashboard > your Pages project > Settings > Variables and secrets):
//   ANTHROPIC_API_KEY  (secret, required)  your key from console.anthropic.com
//   MODEL              (optional)          defaults to claude-haiku-4-5-20251001
//   ALLOWED_ORIGIN     (optional)          e.g. https://aibridge.example — blocks other sites from using your tutor
//   DAILY_LIMIT        (optional)          questions per visitor per day, default 40 (needs the KV binding below)
// Binding (optional, recommended):
//   TUTOR_KV           KV namespace used for the per-visitor daily limit

const SYSTEM = `You are the AI tutor on "AI Bridge by Ines", an educational website.
Help learners with Python, programming, AI, machine learning, computer vision, generative AI and LLMs, software development and research methodology.
Politely decline requests that have nothing to do with learning these topics.
The first user message contains the page context and style instructions from the website; follow them.`;

const MAX_MESSAGES = 30;
const MAX_CHARS = 24000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

  // Clean and validate the conversation
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content }));
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else merged.push(m);
  }
  messages = merged.slice(-MAX_MESSAGES);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "bad_request" }, 400);
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return json({ error: "too_large" }, 413);

  // Per-visitor daily limit (only if a KV namespace is bound as TUTOR_KV)
  if (env.TUTOR_KV) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = `rl:${new Date().toISOString().slice(0, 10)}:${ip}`;
    const used = parseInt((await env.TUTOR_KV.get(key)) || "0", 10);
    if (used >= parseInt(env.DAILY_LIMIT || "40", 10)) return json({ error: "rate_limited" }, 429);
    await env.TUTOR_KV.put(key, String(used + 1), { expirationTtl: 60 * 60 * 25 });
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 900,
      system: SYSTEM,
      messages
    })
  });

  if (!upstream.ok) {
    if (upstream.status === 429) return json({ error: "rate_limited" }, 429);
    return json({ error: "upstream_error" }, 502);
  }
  const data = await upstream.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return json({ text, truncated: data.stop_reason === "max_tokens" });
}
