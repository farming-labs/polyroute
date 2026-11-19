// Native addons and mapped machine code stay owned by this process. The
// parent waits for its exit before removing any of the deployment artifacts.
process.on("message", async ({ id, type, url, name, request }) => {
  try {
    const routes = await import(url);
    let value;
    if (type === "load") {
      value = Object.entries(routes)
        .filter(([, route]) => typeof route?.fetch === "function")
        .map(([name, route]) => [name, route.route]);
    } else {
      const response = await routes[name].fetch(new Request(request.url, request));
      value = {
        status: response.status,
        headers: [...response.headers],
        body: response.body === null ? null : Buffer.from(await response.arrayBuffer()),
      };
    }
    process.send({ id, value });
  } catch (error) {
    process.send({ id, error: { name: error.name, message: error.message, code: error.code } });
  }
});
