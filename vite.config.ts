import type { IncomingMessage } from "node:http";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/** Body of a POST /api/* request, parsed as JSON. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}

/** Serves /api/* from src/server/api.ts, loaded through Vite so edits hot-reload. */
function api(): Plugin {
  return {
    name: "ff-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        try {
          const mod = (await server.ssrLoadModule("/@fs/" + server.config.root + "/../src/server/api.ts")) as typeof import("./src/server/api.js");
          const logoId = url.pathname.match(/^\/api\/logo\/([^/]+)$/)?.[1];
          if (logoId) {
            const logo = await mod.fetchLogo(logoId);
            res.setHeader("Content-Type", logo.type);
            res.setHeader("Cache-Control", "private, max-age=86400");
            res.end(Buffer.from(logo.body));
            return;
          }
          res.setHeader("Content-Type", "application/json");
          let body: unknown;
          if (url.pathname === "/api/acquire") {
            if (req.method !== "POST") throw new Error("POST only");
            res.setHeader("Cache-Control", "no-store");
            body = await mod.acquire(await readJson<Parameters<typeof mod.acquire>[0]>(req));
          } else if (url.pathname === "/api/propose") {
            if (req.method !== "POST") throw new Error("POST only");
            body = await mod.propose(await readJson<Parameters<typeof mod.propose>[0]>(req));
          } else if (url.pathname === "/api/accept-trade") {
            if (req.method !== "POST") throw new Error("POST only");
            res.setHeader("Cache-Control", "no-store");
            body = await mod.acceptTrade(await readJson<Parameters<typeof mod.acceptTrade>[0]>(req));
          } else if (url.pathname === "/api/cancel-trade") {
            if (req.method !== "POST") throw new Error("POST only");
            body = await mod.cancelTrade(await readJson<Parameters<typeof mod.cancelTrade>[0]>(req));
          } else if (url.pathname === "/api/trade-odds") {
            if (req.method !== "POST") throw new Error("POST only");
            res.setHeader("Cache-Control", "no-store");
            // Minutes of worker CPU: if the page gives up on the trade, so do we.
            const abandoned = new AbortController();
            res.on("close", () => { if (!res.writableEnded) abandoned.abort(); });
            body = await mod.tradeOdds(await readJson<Parameters<typeof mod.tradeOdds>[0]>(req), abandoned.signal);
          } else if (url.pathname === "/api/lineup") {
            if (req.method !== "POST") throw new Error("POST only");
            body = await mod.saveLineup(await readJson<Parameters<typeof mod.saveLineup>[0]>(req));
          } else if (url.pathname === "/api/roster") body = await mod.roster(url.searchParams);
          else if (url.pathname === "/api/matchup") {
            if (req.method !== "GET") throw new Error("GET only");
            res.setHeader("Cache-Control", "no-store");
            body = await mod.matchup(url.searchParams);
          }
          else if (url.pathname === "/api/scores") {
            if (req.method !== "GET") throw new Error("GET only");
            res.setHeader("Cache-Control", "no-store");
            body = await mod.scores(url.searchParams);
          }
          else if (url.pathname === "/api/acquisition") {
            if (req.method !== "GET") throw new Error("GET only");
            res.setHeader("Cache-Control", "no-store");
            body = await mod.acquisition(url.searchParams);
          }
          else if (url.pathname === "/api/pending") body = await mod.pending(url.searchParams);
          else if (url.pathname === "/api/defaults") body = mod.defaults();
          else if (url.pathname === "/api/leagues") body = await mod.leagues();
          else if (url.pathname === "/api/rate") body = await mod.rate(url.searchParams);
          else if (url.pathname === "/api/draft") body = await mod.draft(url.searchParams);
          else if (url.pathname === "/api/aid") body = await mod.aid(url.searchParams);
          else if (url.pathname === "/api/picks") body = await mod.picks(url.searchParams);
          else {
            res.statusCode = 404;
            body = { error: "not found" };
          }
          res.end(JSON.stringify(body));
        } catch (e) {
          if (res.writableEnded || res.destroyed) return;
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === "serve") {
    try {
      process.loadEnvFile();
    } catch {
      /* rely on the environment */
    }
  }
  return {
    root: "web",
    plugins: [solid(), api()],
    server: { fs: { allow: [".."] } },
    build: { outDir: "../dist/web", emptyOutDir: true },
  };
});
