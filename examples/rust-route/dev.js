import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const vite = await createViteServer({ server: { middlewareMode: true }, appType: "custom" });

const server = createHttpServer(async (req, res) => {
  try {
    // Loading per request picks up edits, including rebuilt `.rs` routes.
    const { handle } = await vite.ssrLoadModule("/src/app.ts");
    const { sendResponse, toRequest } = await vite.ssrLoadModule("/src/node.ts");
    await sendResponse(res, await handle(toRequest(req)));
  } catch (error) {
    vite.ssrFixStacktrace(error);
    console.error(error);
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`dev server on http://${host}:${server.address().port}`);
});
