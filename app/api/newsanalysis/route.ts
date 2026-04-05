/**
 * POST /api/newsanalysis
 *
 * Streams a 2–3 sentence GEOINT-style AI analysis for a single news
 * article or conflict event.  Same key detection as /api/sitrep:
 * GROQ_API_KEY preferred (free), OPENAI_API_KEY as fallback.
 *
 * Body:
 *   { title: string; domain?: string; seenAt?: string; country?: string; context?: string }
 *
 * Stream format: SSE — `data: {"text":"…"}\n\n` … `data: [DONE]\n\n`
 */

import OpenAI from "openai";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function makeClient(): { client: OpenAI; model: string } | null {
  if (process.env.GROQ_API_KEY) {
    return {
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
      }),
      model: "llama-3.1-8b-instant",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      model: "gpt-4o-mini",
    };
  }
  return null;
}

export async function POST(req: NextRequest) {
  const ai = makeClient();
  if (!ai) {
    return new Response(
      JSON.stringify({ error: "no-key" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await req.json() as {
    title?:   string;
    domain?:  string;
    seenAt?:  string;
    country?: string;
    context?: string; // extra info (actor, event type, etc. for conflict events)
  };

  const { title = "(no title)", domain = "", seenAt = "", country = "", context = "" } = body;

  const when = seenAt
    ? new Date(seenAt).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC"
    : "recent";

  const source = [domain, country].filter(Boolean).join(" · ");

  const prompt =
    `You are a GEOINT intelligence analyst providing rapid situational analysis.\n\n` +
    `NEWS ITEM:\n` +
    `Title: ${title}\n` +
    (source  ? `Source: ${source}\n`  : "") +
    (when    ? `Seen: ${when}\n`      : "") +
    (context ? `Context: ${context}\n` : "") +
    `\nProvide a 2-sentence intelligence assessment: ` +
    `(1) what is actually happening and who is involved, ` +
    `(2) the strategic or operational significance. ` +
    `Be precise and factual. Plain prose only — no markdown, no bullet points.`;

  try {
    const upstream = await ai.client.chat.completions.create({
      model:       ai.model,
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  130,
      temperature: 0.4,
      stream:      true,
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of upstream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`)
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
          );
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
      cancel() {
        upstream.controller.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type":      "text/event-stream; charset=utf-8",
        "Cache-Control":     "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection:          "keep-alive",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
