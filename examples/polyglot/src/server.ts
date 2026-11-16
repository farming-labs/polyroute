import { createServer } from "node:http";
import { handle } from "./app";
import { sendResponse, toRequest } from "./node";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  try {
    await sendResponse(res, await handle(toRequest(req)));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`listening on http://${host}:${actualPort}`);
});
