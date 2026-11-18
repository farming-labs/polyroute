export async function GET(request: Request): Promise<Response> {
  const upstream = new URL("/api/hello", request.url);
  if (!["localhost", "127.0.0.1"].includes(upstream.hostname)) {
    return new Response("The upstream host is not allowed.", { status: 502 });
  }
  try {
    const response = await fetch(upstream, { redirect: "manual" });
    return new Response(`{"relayed":${await response.text()}}`, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response("The upstream request failed.", { status: 502 });
  }
}
