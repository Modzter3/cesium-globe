export const runtime = "edge";

export async function GET() {
  const key = process.env.AISSTREAM_API_KEY ?? "";
  return Response.json({
    key_set: !!key,
    key_length: key.length,
    key_preview: key ? key.slice(0, 8) + "..." : "MISSING",
    runtime: "edge",
  });
}
