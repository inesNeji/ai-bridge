// Cloudflare Pages Function: POST /api/tutor
// Runs the chatbot on the server side (free Workers AI, or Claude if a key is set) so no secret ends up in the page.
//
// Two ways to power the tutor:
//   FREE (default): Cloudflare Workers AI. Add a Workers AI binding named AI
//     (Pages project > Settings > Bindings > Add > Workers AI). No key, no card.
//     The free plan includes 10,000 "neurons" per day (roughly 60-80 tutor answers);
//     when they run out, the tutor pauses until the next day. It never bills you.
//   PAID (optional): Claude. Add a secret ANTHROPIC_API_KEY. If set, it is used instead.
//
// Settings (Cloudflare dashboard > your Pages project > Settings > Variables and secrets):
//   ANTHROPIC_API_KEY  (secret, optional)  your key from console.anthropic.com
//   MODEL              (optional)          model name; defaults depend on the provider below
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
  if (!originAllowed(origin, env.ALLOWED_ORIGIN)) return json({ error: "forbidden", detail: "Origin " + origin + " is not ALLOWED_ORIGIN" }, 403);
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: "not_configured" }, 503);

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

  if (env.ANTHROPIC_API_KEY) return askClaude(env, messages);
  return askWorkersAI(env, messages);
}

// Tried in order; if one is unavailable (Cloudflare retires models), the next is used.
const WORKERS_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/google/gemma-3-12b-it",
  "@cf/qwen/qwen3-30b-a3b-fp8"
];

function extractText(result) {
  if (!result) return "";
  if (typeof result.response === "string") return result.response;
  if (result.response && typeof result.response === "object") return JSON.stringify(result.response);
  const c = result.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (typeof result.output_text === "string") return result.output_text;
  return "";
}

async function askWorkersAI(env, messages) {
  const models = env.MODEL ? [env.MODEL, ...WORKERS_MODELS] : WORKERS_MODELS;
  let lastError = "";
  for (const model of models) {
    try {
      const result = await env.AI.run(model, {
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        max_tokens: 900
      });
      const text = extractText(result).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (text) return json({ text, truncated: false, model });
      lastError = "empty response from " + model;
    } catch (err) {
      lastError = String(err && err.message || err);
      // Free daily allocation used up: stop trying, every model shares it.
      if (/neuron|daily|quota|allocation|4006|429/i.test(lastError)) return json({ error: "rate_limited" }, 429);
    }
  }
  return json({ error: "upstream_error", detail: lastError.slice(0, 300) }, 502);
}

async function askClaude(env, messages) {
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

function originAllowed(origin, allowed) {
  if (!allowed || !origin) return true;
  if (origin === allowed) return true;
  try {
    // also accept preview deployments such as https://1a2b3c4d.ai-bridge-4m2.pages.dev
    return new URL(origin).hostname.endsWith("." + new URL(allowed).hostname);
  } catch { return false; }
}

// Open /api/tutor in the browser to check the setup. Add ?test=1 to send a tiny test question.
export async function onRequestGet({ request, env }) {
  const status = {
    workers_ai_binding_AI: !!env.AI,
    claude_key_set: !!env.ANTHROPIC_API_KEY,
    allowed_origin: env.ALLOWED_ORIGIN || "(not set)",
    rate_limit_kv: !!env.TUTOR_KV
  };
  if (new URL(request.url).searchParams.get("test")) {
    const r = env.ANTHROPIC_API_KEY
      ? await askClaude(env, [{ role: "user", content: "Say hello in five words." }])
      : env.AI ? await askWorkersAI(env, [{ role: "user", content: "Say hello in five words." }])
      : json({ error: "not_configured" }, 503);
    status.test_status = r.status;
    status.test_result = await r.json();
  }
  return json(status);
}
