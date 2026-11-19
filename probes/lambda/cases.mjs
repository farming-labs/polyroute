import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";

export async function runCases({ fixture, check }) {
  for (const perRequest of [false, true]) {
    await check(`Rust reuse=${!perRequest}, trap error and recovery`, () =>
      fixture("counter/route.rs", { perRequest }, async (h) => {
        assert.equal((await h.request()).text, "1");
        assert.equal((await h.request()).text, perRequest ? "1" : "2");
        assert.equal((await h.request("/panic")).status, 500);
        assert.equal((await h.request()).text, "1");
        assert.match(await h.logs(), /counter panicked on request/);
      }),
    );
    await check(`Go reuse=${!perRequest} and replacement`, () =>
      fixture("go/counter/route.go", { perRequest }, async (h) => {
        for (let i = 0; i < (perRequest ? 4 : 1002); i++)
          assert.equal((await h.request()).text, String(perRequest ? 1 : (i % 1000) + 1));
      }),
    );
    await check(`Rust URI, query and body reuse=${!perRequest}`, () =>
      fixture("echo/route.rs", { perRequest }, async (h) => {
        const r = await h.request("/hello?name=farm", {
          method: "POST",
          headers: { "x-greeting": "hello" },
          body: "a".repeat(65536),
        });
        assert.equal(r.status, 201);
        assert.equal(r.headers["x-served-by"], "rust");
        assert.equal(
          r.text,
          `method=POST\npath=/hello?name=farm\ngreeting=hello\nbody=${"a".repeat(65536)}\n`,
        );
      }),
    );
    await check(`Python bytes, cookies, retained body and validation reuse=${!perRequest}`, () =>
      fixture("python/response/route.py", { perRequest }, async (h) => {
        for (const n of [0, 1, 4095, 4096, 4097, 65535, 65536, 65537, 1048577]) {
          const body = Buffer.alloc(n);
          for (let i = 0; i < n; i++) body[i] = i % 256;
          const r = await h.request("/", { method: "POST", body });
          assert.equal(r.status, 200);
          assert.deepEqual(r.bytes, body);
        }
        for (const [input, expected] of [
          ["first", "first"],
          ["second", perRequest ? "second" : "first"],
        ])
          assert.equal(
            (await h.request("/?case=retain", { method: "POST", body: input })).text,
            expected,
          );
        assert.deepEqual((await h.request("/?case=cookies")).cookies, ["a=1", "b=2"]);
        for (const invalid of [
          "short",
          "long",
          "length",
          "header-name",
          "header-value",
          "forbidden",
          "negative",
          "huge",
          "float",
          "string",
        ]) {
          assert.equal((await h.request(`/?case=${invalid}`)).status, 500, invalid);
          assert.equal((await h.request("/?case=created")).status, 201);
        }
      }),
    );
  }
  await check("Python absolute URI, query and incoming cookies", () =>
    fixture("python/response/route.py", {}, async (h) => {
      const r = await h.request("/one%20two?case=request&a=one%20two&a=three", {
        cookies: ["a=1", "b=2"],
      });
      const b = JSON.parse(r.text);
      assert.equal(b.url, "https://function.example/one%20two?case=request&a=one%20two&a=three");
      assert.equal(b.headers.cookie, "a=1; b=2");
    }),
  );
  await check("Python Latin-1 response header preservation", () =>
    fixture("python/response/route.py", {}, async (h) => {
      const r = await h.request("/?case=latin1");
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-probe"], "café");
    }),
  );
  await check("Incoming Latin-1 JSON header stays unchanged", () =>
    fixture("python/response/route.py", {}, async (h) => {
      const r = await h.request("/?case=request", { headers: { "x-probe": "café" } });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.text).headers["x-probe"], "café");
    }),
  );
  await check("Non-Latin-1 incoming header fails closed and recovers", () =>
    fixture("python/response/route.py", {}, async (h) => {
      assert.equal(
        (await h.request("/?case=request", { headers: { "x-probe": "λ" } })).status,
        500,
      );
      assert.equal((await h.request("/?case=created")).status, 201);
    }),
  );
  await check("HEAD suppresses body and retains warm state", () =>
    fixture("counter/route.rs", {}, async (h) => {
      const r = await h.request("/", { method: "HEAD" });
      assert.equal(r.status, 200);
      assert.equal(r.bytes.length, 0);
      assert.equal((await h.request()).text, "2");
    }),
  );
  await check("Malformed invocation errors and next invocation recovers", () =>
    fixture("counter/route.rs", {}, async (h) => {
      const r = await h.invoke({ unrelated: true });
      assert.equal(r.kind, "error");
      assert.equal((await h.request()).text, "1");
    }),
  );
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const c of req) body += c;
    res.writeHead(201, { "content-type": "text/plain" });
    res.end(`${req.method} ${req.url} x-sent-by=${req.headers["x-sent-by"]} body=${body}`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const base = `http://127.0.0.1:${upstream.address().port}`;
  try {
    for (const [lang, key] of [
      ["rust", "outbound/route.rs"],
      ["go", "go/outbound/route.go"],
      ["python", "python/outbound/route.py"],
    ]) {
      await check(`${lang} allowed outbound and per-request policy denial`, () =>
        fixture(key, { outboundAllow: ["127.0.0.1"] }, async (h) => {
          let r = await h.request("/", { headers: { "x-upstream": `${base}/echo?name=farm` } });
          assert.equal(r.status, 200);
          assert.equal(r.text, `GET /echo?name=farm x-sent-by=${lang} body=`);
          r = await h.request("/", {
            method: "POST",
            headers: { "x-upstream": `${base}/echo` },
            body: "payload",
          });
          assert.equal(r.text, `POST /echo x-sent-by=${lang} body=payload`);
          const before = calls;
          r = await h.request("/", {
            headers: { "x-upstream": `${base.replace("127.0.0.1", "localhost")}/denied` },
          });
          assert.equal(r.status, 502);
          assert.equal(calls, before);
        }),
      );
      await check(`${lang} outbound denied by default`, () =>
        fixture(key, {}, async (h) => {
          const before = calls;
          const r = await h.request("/", { headers: { "x-upstream": `${base}/denied` } });
          assert.ok([500, 502].includes(r.status));
          assert.equal(calls, before);
        }),
      );
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}
