export function GET(request: Request): Response {
  const text = new URL(request.url).searchParams.get("text") ?? "";
  const slug = (text.toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? []).join("-");
  // Match the Go example's sorted JSON keys and trailing newline too.
  return new Response(`${JSON.stringify({ slug, text })}\n`, {
    headers: { "content-type": "application/json" },
  });
}
