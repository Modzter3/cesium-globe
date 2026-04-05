/**
 * GET /api/newsfeed
 *
 * Aggregates world-news RSS feeds from BBC and Al Jazeera — completely free,
 * no API key required, no rate limits.  Results are merged, sorted by
 * publication date, and cached for 20 minutes.
 *
 * Cache lives on `globalThis` so it survives Next.js hot-reloads in dev,
 * preventing repeated rapid fetches.
 */

import { NextResponse } from "next/server";

export interface NewsArticle {
  title:   string;
  url:     string;
  domain:  string;
  seenAt:  string; // ISO 8601
  country: string;
}

const FEEDS = [
  {
    url:     "https://feeds.bbci.co.uk/news/world/rss.xml",
    domain:  "bbc.com",
    country: "United Kingdom",
  },
  {
    url:     "https://www.aljazeera.com/xml/rss/all.xml",
    domain:  "aljazeera.com",
    country: "Qatar",
  },
];

const CACHE_TTL_MS = 20 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var _newsfeedCache: { articles: NewsArticle[]; ts: number } | undefined;
}

// ── Minimal RSS parser (handles plain text & CDATA titles) ───────────────────

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}

function extractTag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return "";
  return unwrapCdata(m[1].trim());
}

function parseItems(xml: string, domain: string, country: string): NewsArticle[] {
  const chunks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  const out: NewsArticle[] = [];

  for (const item of chunks) {
    const title   = extractTag(item, "title");
    const link    = extractTag(item, "link");
    const guid    = extractTag(item, "guid");
    const pubDate = extractTag(item, "pubDate");

    const url = link.startsWith("http") ? link
              : guid.startsWith("http") ? guid
              : "";

    if (!title || !url) continue;

    let seenAt = "";
    if (pubDate) {
      try { seenAt = new Date(pubDate).toISOString(); } catch { /* ignore */ }
    }

    out.push({ title, url, domain, seenAt, country });
  }

  return out;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const now = Date.now();

  if (global._newsfeedCache && now - global._newsfeedCache.ts < CACHE_TTL_MS) {
    return NextResponse.json({ articles: global._newsfeedCache.articles });
  }

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        signal:  AbortSignal.timeout(8_000),
        headers: {
          "Accept":     "application/rss+xml, application/xml, text/xml, */*",
          "User-Agent": "GlobalSentinel/1.0 (news aggregator)",
        },
      });
      if (!res.ok) throw new Error(`${feed.domain} RSS ${res.status}`);
      const xml = await res.text();
      return parseItems(xml, feed.domain, feed.country);
    })
  );

  const articles: NewsArticle[] = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    // sort newest first
    .sort((a, b) => {
      if (!a.seenAt) return 1;
      if (!b.seenAt) return -1;
      return b.seenAt.localeCompare(a.seenAt);
    })
    .slice(0, 25);

  if (articles.length === 0 && global._newsfeedCache) {
    // All feeds failed — serve stale rather than empty
    return NextResponse.json({ articles: global._newsfeedCache.articles });
  }

  if (articles.length > 0) {
    global._newsfeedCache = { articles, ts: now };
  }

  return NextResponse.json({ articles });
}
