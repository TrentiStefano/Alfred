import { log } from "node:console";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8080;
const HOLD_QUERY = "alfred-hold-search";

// Check before starting the server so a misconfigured container cannot serve the fixture.
if (
  Object.values(networkInterfaces())
    .flat()
    .some((address) => address?.internal === false)
) {
  throw new Error("The synthetic SearXNG Environment requires an isolated network.");
}

const result = {
  url: "https://fixture.invalid/synthetic-search",
  title: "Alfred synthetic search result",
  content: "A deterministic result from the synthetic SearXNG endpoint.",
  engine: "synthetic",
  engines: ["synthetic"],
  category: "general",
  score: 1,
  positions: [1],
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const query = url.searchParams.get("q");
  if (
    request.method !== "GET" ||
    url.pathname !== "/search" ||
    url.searchParams.get("format") !== "json" ||
    !query
  ) {
    response.writeHead(404).end();
    return;
  }
  if (query === HOLD_QUERY) {
    // The interruption check waits for this marker before stopping the Environment.
    log("synthetic search waiting");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      query,
      number_of_results: 1,
      results: [result],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsive_engines: [],
    }),
  );
}).listen(PORT, HOST);
