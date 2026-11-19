export function deferred() {
  return Promise.withResolvers();
}
export async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`timeout: ${label}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function event(path = "/", { method = "GET", headers = {}, body = "", cookies } = {}) {
  const url = new URL(path, "https://function.example");
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: { host: "function.example", "x-forwarded-proto": "https", ...headers },
    cookies,
    requestContext: {
      accountId: "123456789012",
      apiId: "probe",
      domainName: "function.example",
      domainPrefix: "function",
      http: {
        method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "local-probe",
      },
      requestId: "event",
      routeKey: "$default",
      stage: "$default",
      time: "18/Nov/2026:00:00:00 +0000",
      timeEpoch: 1794960000000,
    },
    body: bytes.toString("base64"),
    isBase64Encoded: true,
  };
}
