# Local open-weight model setup — companion to Phase 4 workstream B3

> Status: **planned**, procedure only. Nothing here touches Counter's codebase
> — this runs inside the separate `counter-agent` repo/VPS described in
> `docs/phase4-whatsapp-order-agent.md` §4 (workstream B). Follow this when
> you build B3's parser fallback.

Scope reminder from the main plan: the LLM only runs when the deterministic
menu parser fails (§B3). It does one narrow job — match fuzzy customer text
to catalog items, or decide to hand off — nothing else. That framing drives
every choice below: pick the smallest model that's reliably good at
structured tool calls, not the biggest model available.

Model names and exact availability drift fast; treat every specific tag below
as "check this is still current" rather than gospel — verify against the
runtime's own model library at setup time.

---

## 1. Decide how you're running it

Two paths. Start with A; move to B only if A's latency or accuracy doesn't
clear the bar in §6.

**A — Ollama, CPU, same VPS as the agent (default).**
Simplest possible setup, no GPU rental, one more container in the compose
file you already have for OpenWA. A quantized ~9B model on 4–8 vCPUs answers
a short tool-call prompt in low single-digit seconds — fine for an
asynchronous WhatsApp reply. This is the right starting point given the
"simple tasks, keep it cheap" brief.

**B — vLLM on a small GPU box.**
Only worth it if A's latency becomes the bottleneck at real volume, or if a
larger model is needed for accuracy. Higher throughput, needs a GPU
(~T4-class is plenty for a 9B model), separate box, more moving parts. Skip
this section entirely on day one; §7 covers the swap when you need it.

The rest of this doc follows path A.

---

## 2. Pick the model

Target family: an open-weight instruct model in the 7–9B range with
documented tool/function-calling support — GLM-4-9B-Chat class. Before
committing:

1. Check `ollama.com/library` for the current GLM tag (it may be published
   as `glm4`, `glm-4`, or under a versioned name — confirm at setup time).
2. Confirm the listed model card explicitly supports tool calling / function
   calling, not just chat. This is the one property that actually matters
   for B3 — a model that's great at conversation but weak at emitting valid
   structured tool calls will silently inflate your handoff rate.
3. If GLM's current Ollama build is weak on tool calls, the fallback
   candidates worth a quick bake-off (same size class, all tool-call capable
   as of last check, verify current versions): Qwen2.5-7B-Instruct,
   Llama-3.1-8B-Instruct. §6 gives you the harness to compare them on your
   own 50 real messages before picking — don't commit on vibes.

---

## 3. Install and run the model (Ollama path)

```bash
# On the agent VPS (or a laptop first, to test before deploying):
curl -fsSL https://ollama.com/install.sh | sh

# Pull the model — confirm the exact tag from ollama.com/library first.
ollama pull glm4:9b        # placeholder tag; verify current name/quant

# Sanity check it answers at all.
ollama run glm4:9b "Say hello in one sentence."
```

Ollama serves an OpenAI-compatible endpoint automatically once running:

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm4:9b",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

If that returns a normal chat completion, the runtime is working. Now check
the thing that actually matters:

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm4:9b",
    "messages": [{"role": "user", "content": "customer wants 2 crates of star beer and the big malt"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "match_products",
        "description": "Match free text to catalog products and units",
        "parameters": {
          "type": "object",
          "properties": {
            "matches": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "productName": {"type": "string"},
                  "unitName": {"type": "string"},
                  "quantity": {"type": "integer"},
                  "confidence": {"type": "number"}
                },
                "required": ["productName", "quantity", "confidence"]
              }
            }
          },
          "required": ["matches"]
        }
      }
    }],
    "tool_choice": "required"
  }'
```

Confirm the response actually contains a `tool_calls` entry with valid JSON
in `arguments` — not the model narrating its answer in plain text instead of
calling the tool. This is the single most common failure mode for smaller
open models and the reason step 2's "verify tool-calling" isn't optional.

---

## 4. Wire it into the agent (workstream B code)

### 4.1 The client interface

Keep the model provider swappable — local today, hosted tomorrow — behind
one interface, matching the gateway-adapter pattern already used for OpenWA:

```ts
// src/llm/client.ts
export interface ProductMatch {
  productName: string;
  unitName?: string;
  quantity: number;
  confidence: number;
}

export interface LlmClient {
  matchProducts(customerText: string): Promise<ProductMatch[] | null>; // null = couldn't parse
}
```

### 4.2 The Ollama-backed implementation

Point the OpenAI SDK at Ollama's local endpoint — no other code changes
needed if you later swap to a hosted provider, per the plan's B3 note.

```ts
// src/llm/ollamaClient.ts
import OpenAI from "openai";
import type { LlmClient, ProductMatch } from "./client";

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL ?? "http://ollama:11434/v1",
  apiKey: "unused", // Ollama ignores this; the SDK requires a non-empty string
});

const MATCH_PRODUCTS_TOOL = {
  type: "function" as const,
  function: {
    name: "match_products",
    description: "Match free-text customer order text to catalog products and units.",
    parameters: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              productName: { type: "string" },
              unitName: { type: "string" },
              quantity: { type: "integer" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["productName", "quantity", "confidence"],
          },
        },
      },
      required: ["matches"],
    },
  },
};

export class OllamaClient implements LlmClient {
  async matchProducts(customerText: string): Promise<ProductMatch[] | null> {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL ?? "glm4:9b",
      temperature: 0,           // deterministic — this is a parser, not a chat partner
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: customerText },
      ],
      tools: [MATCH_PRODUCTS_TOOL],
      tool_choice: "required",
    });

    const call = res.choices[0]?.message.tool_calls?.[0];
    if (!call) return null;                       // model didn't call the tool → handoff

    try {
      const parsed = JSON.parse(call.function.arguments);
      // Re-validate with the SAME schema the tool declared — never trust
      // the model's JSON just because it parsed.
      if (!Array.isArray(parsed.matches) || parsed.matches.length === 0) return null;
      for (const m of parsed.matches) {
        if (typeof m.productName !== "string" || typeof m.quantity !== "number") return null;
        if (typeof m.confidence !== "number" || m.confidence < 0.6) return null; // low-confidence → handoff
      }
      return parsed.matches as ProductMatch[];
    } catch {
      return null;                                 // malformed JSON → handoff, never guess
    }
  }
}

const SYSTEM_PROMPT = `You match a WhatsApp customer's order text to catalog
products. Only call match_products. Never invent a product that wasn't
plausibly meant. If the text is ambiguous or you're not confident, return an
empty matches array rather than guessing.`;
```

### 4.3 The caller — where this plugs into B3's state machine

```ts
// in the BUILDING_ORDER state handler, after the deterministic parser fails:
const llmMatches = await withTimeout(llmClient.matchProducts(customerText), 8_000);
if (!llmMatches) {
  return handoff(chat, "couldn't confidently parse the order");
}
const resolved = await resolveAgainstCatalog(llmMatches); // fuzzy-match names -> real product/unit ids
if (resolved.unresolved.length > 0) {
  return handoff(chat, `unrecognized items: ${resolved.unresolved.join(", ")}`);
}
// only now build the confirmation echo (§B3 step 3) — the LLM never sees
// or produces a price; resolved ids go to /agent/v1/orders which prices
// them server-side.
```

Three things this code enforces, all load-bearing:

- **`null` is the default outcome**, not an exception path — any failure to
  parse, low confidence, or malformed JSON returns `null`, which routes to
  handoff. The model errs toward giving up, not guessing.
- **A hard timeout** wraps the call — a slow/hung local model must not stall
  the conversation indefinitely; timeout also routes to handoff.
- **The model never touches a price.** It only returns product/unit names
  and quantities; those get resolved to catalog ids and sent to the
  already-planned `/agent/v1/orders` endpoint, which re-prices server-side
  (main plan, §A2). This is the same untrusted-middle-layer principle as the
  till's price floor, just one hop earlier.

---

## 5. Docker Compose — the third container

Add Ollama alongside `openwa` and `agent` in the same compose file:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_models:/root/.ollama   # persist pulled weights across restarts
    restart: unless-stopped
    # No ports published to the host — only the agent container reaches it,
    # over the compose network, same discipline as OpenWA's dashboard.
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 30s
      timeout: 10s
      retries: 3

  agent:
    build: .
    depends_on:
      ollama:
        condition: service_healthy
      openwa:
        condition: service_started
    environment:
      LLM_BASE_URL: "http://ollama:11434/v1"
      LLM_MODEL: "glm4:9b"
      # ...central store URL/token, OpenWA URL/key, per main plan §B1
    restart: unless-stopped

volumes:
  ollama_models:
```

First boot needs the model pulled once — either bake a `RUN ollama pull
glm4:9b` step into a custom Ollama image, or run `docker compose exec ollama
ollama pull glm4:9b` manually after first `up`. Baking it in is worth doing
before this goes anywhere near production, so a fresh deploy doesn't silently
run without a model loaded.

Resource note: set a memory limit on the `ollama` service (`deploy.resources.limits.memory`,
e.g. `8g` for a 9B Q4 model) so a runaway load doesn't take down the `agent`
and `openwa` containers sharing the box.

---

## 6. Test before it touches real customers

This is the M4 milestone from the main plan, made concrete:

1. Collect (or write) ~50 realistic order messages — mix languages/slang
   your customers actually use, include a handful of deliberately ambiguous
   ones and a few that should legitimately hand off.
2. Run each through `matchProducts()` directly (a small script, not through
   WhatsApp) and log: did it call the tool, was the JSON valid, did it match
   the *correct* product/quantity, what was `confidence`.
3. Compute wrong-parse rate (confidently wrong, not handed off) and handoff
   rate. Target from the main plan: wrong-parse rate near zero — the
   confirmation echo is a backstop, not a substitute for this.
4. If GLM's numbers are weak, swap `LLM_MODEL` to the Qwen/Llama fallback
   candidates from §2 and rerun the same 50 messages — same harness, so the
   comparison is apples-to-apples. Keep whichever wins; nothing else in the
   agent changes since they're all behind the same `LlmClient` interface.
5. Re-run this whenever you change the model, the tag/quantization, or the
   system prompt. Treat it as a regression suite, not a one-time check.

---

## 7. Swapping later — local → hosted, or model → model

Because everything above sits behind `LlmClient` and env-configured
`LLM_BASE_URL`/`LLM_MODEL`, three kinds of change are all "edit config,
redeploy," never a code change:

- **Different local model** — change `LLM_MODEL`, re-pull, rerun §6.
- **Different local runtime** (Ollama → vLLM) — new implementation of the
  same `LlmClient` interface if vLLM's request shape differs meaningfully;
  otherwise vLLM's OpenAI-compatible server is a drop-in `LLM_BASE_URL`
  change.
- **Hosted model** (if local ever proves too slow/inaccurate for the volume)
  — point `LLM_BASE_URL` at the hosted provider's OpenAI-compatible endpoint
  and set `LLM_API_KEY`. Same code path, same tool schema, same confirm gate.

## 8. Security note

Ollama's API has no auth by default — that's fine only because it's never
published to the host or the internet (§5: no `ports:` mapping, reachable
only inside the compose network). If you ever need to reach it from outside
that network for debugging, put it behind the same kind of bearer-token
reverse proxy discipline used everywhere else in this system — never expose
it raw.
