import { describe, expect, it } from "vitest";
import { sendsRequests } from "./python.js";

describe("sendsRequests", () => {
  it("finds the imports that need `wasi:http/outgoing-handler`", () => {
    for (const source of [
      "from polyroute_fetch import fetch\n",
      "import poll_loop\n",
      "from poll_loop import PollLoop, Stream\n",
      "from wit_world.imports import outgoing_handler\n",
      "import wit_world.imports.outgoing_handler as handler\n",
      "async def GET(request):\n    from polyroute_fetch import fetch\n",
    ]) {
      expect(sendsRequests(source), source).toBe(true);
    }
  });

  it("ignores routes that don't send requests", () => {
    for (const source of [
      "from polyroute import Request, Response\n",
      "import polyroute_fetcher\n",
      "# Call polyroute_fetch from here later.\n",
      "x = 'import poll_loop'\n",
    ]) {
      expect(sendsRequests(source), source).toBe(false);
    }
  });
});
