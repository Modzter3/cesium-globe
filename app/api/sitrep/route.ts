/**
 * POST /api/sitrep
 *
 * Streams an AI-generated GEOINT situation report as Server-Sent Events.
 *
 * Prefers Groq (free, fast) when GROQ_API_KEY is set, otherwise falls back
 * to OpenAI when OPENAI_API_KEY is set.  Returns 503 when neither key is
 * present so the UI can show a sensible "configure key" state.
 *
 * Body shape (all fields optional for graceful degradation):
 *   {
 *     conflicts:    { country?: string; eventType?: string; fatalities?: number }[];
 *     earthquakes:  { mag: number; place: string; tsunami?: number }[];
 *     spaceWeather: { kp: number; label: string; solarWindSpeed: number; bz: number } | null;
 *     flightCount:  number;
 *     vesselCount:  number;
 *   }
 *
 * Stream format: standard SSE — `data: {"text":"…"}\n\n` chunks, then `data: [DONE]\n\n`.
 */

import OpenAI from "openai";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Model selection ──────────────────────────────────────────────────────────

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

// ── Prompt builder ───────────────────────────────────────────────────────────

interface ConflictRow  { country?: string; eventType?: string; fatalities?: number }
interface QuakeRow     { mag: number; place: string; tsunami?: number }
interface SwRow        { kp: number; label: string; solarWindSpeed: number; bz: number }

function buildPrompt(
  conflicts: ConflictRow[],
  earthquakes: QuakeRow[],
  sw: SwRow | null,
  flightCount: number,
  vesselCount: number,
  newsHeadlines: string[] = [],
): string {
  const utcNow = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // Top conflict regions (by event count)
  const regionMap: Record<string, number> = {};
  for (const c of conflicts) {
    if (c.country) regionMap[c.country] = (regionMap[c.country] ?? 0) + 1;
  }
  const topRegions = Object.entries(regionMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([r, n]) => `${r} (${n})`)
    .join(", ") || "none reported";

  // Fatalities
  const totalFatalities = conflicts.reduce((s, c) => s + (c.fatalities ?? 0), 0);

  // Largest quake
  const sortedQuakes = [...earthquakes].sort((a, b) => b.mag - a.mag);
  const biggestQuake = sortedQuakes[0];
  const tsunamiCount = earthquakes.filter((q) => q.tsunami === 1).length;
  const quakeLine = biggestQuake
    ? `${earthquakes.length} M2.5+ events; largest M${biggestQuake.mag} ${biggestQuake.place}` +
      (tsunamiCount > 0 ? `; ${tsunamiCount} tsunami alert(s) active` : "")
    : "no significant seismic activity";

  // Space weather
  const swParts: string[] = [];
  if (sw) {
    swParts.push(`Kp ${sw.kp} (${sw.label})`);
    if (sw.solarWindSpeed != null) swParts.push(`solar wind ${Math.round(sw.solarWindSpeed)} km/s`);
    if (sw.bz != null)             swParts.push(`Bz ${sw.bz >= 0 ? "+" : ""}${sw.bz.toFixed(1)} nT`);
  }
  const swLine = swParts.length ? swParts.join(", ") : "data unavailable";

  const newsSection = newsHeadlines.length > 0
    ? `\n• Live news headlines (past 6 h):\n${newsHeadlines.slice(0, 8).map((h, i) => `  ${i + 1}. ${h}`).join("\n")}`
    : "";

  return `You are a geospatial intelligence (GEOINT) analyst providing a real-time situation report for a global monitoring platform.

SENSOR DATA — ${utcNow}
• Conflict events (GDELT, past 24 h): ${conflicts.length} events. Top regions: ${topRegions}. Estimated fatalities: ${totalFatalities}.
• Seismic: ${quakeLine}.
• Space weather: ${swLine}.
• Aviation: ${flightCount.toLocaleString()} aircraft tracked globally.
• Maritime: ${vesselCount.toLocaleString()} vessels monitored.${newsSection}

Generate a professional 3-sentence GEOINT situation report. Lead with the most operationally significant development, incorporating breaking news context where relevant. Be precise, factual, and concise — intelligence style. Plain prose only; no markdown, no bullet points.`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const ai = makeClient();
  if (!ai) {
    return new Response(
      JSON.stringify({ error: "No AI key configured. Add GROQ_API_KEY or OPENAI_API_KEY to .env.local." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: {
    conflicts?:     ConflictRow[];
    earthquakes?:   QuakeRow[];
    spaceWeather?:  SwRow | null;
    flightCount?:   number;
    vesselCount?:   number;
    newsHeadlines?: string[];
  };

  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const {
    conflicts     = [],
    earthquakes   = [],
    spaceWeather  = null,
    flightCount   = 0,
    vesselCount   = 0,
    newsHeadlines = [],
  } = body;

  const prompt = buildPrompt(conflicts, earthquakes, spaceWeather, flightCount, vesselCount, newsHeadlines);

  try {
    const upstream = await ai.client.chat.completions.create({
      model:      ai.model,
      messages:   [{ role: "user", content: prompt }],
      max_tokens: 180,
      temperature: 0.55,
      stream:     true,
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
        // Abort the upstream call when the client disconnects
        upstream.controller.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type":  "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection:      "keep-alive",
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
