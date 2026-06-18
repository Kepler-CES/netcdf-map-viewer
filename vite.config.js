import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";

// Dev middleware that relays /nosc/* to https://nosc.go.kr with a CLEAN
// server-side request (Node fetch), the way curl does.
//
// Why not Vite's built-in `server.proxy`? http-proxy forwards the browser's
// full header set (sec-fetch-*, Chrome UA, cookies, referer, ...). NOSC's WAF
// flags that as a "deceptive request" and returns 400. A fresh fetch with
// minimal headers (like curl) passes. This also handles the http→https apex
// redirect server-side, so the browser never makes a cross-origin hop.
//
// NOTE: dev-only. A production build needs its own backend for the same paths.
function noscApiDev() {
  return {
    name: "nosc-api-dev",
    configureServer(server) {
      server.middlewares.use("/nosc", async (req, res) => {
        const url = "https://nosc.go.kr" + req.url; // req.url already has /nosc stripped
        try {
          const upstream = await fetch(url, {
            headers: { Accept: "*/*", "User-Agent": "curl/8.0" },
            redirect: "follow",
          });
          res.statusCode = upstream.status;
          const ct = upstream.headers.get("content-type");
          if (ct) res.setHeader("Content-Type", ct);
          const cl = upstream.headers.get("content-length");
          if (cl) res.setHeader("Content-Length", cl);
          // Stream the body straight through instead of buffering the whole
          // file in Node memory (these OPeNDAP responses can be >1GB, which
          // caused 502s and big memory spikes when fully buffered).
          if (upstream.body) {
            const node = Readable.fromWeb(upstream.body);
            node.on("error", () => res.destroy());
            node.pipe(res);
          } else {
            res.end();
          }
        } catch (e) {
          res.statusCode = 502;
          res.end("NOSC proxy error: " + (e?.message || String(e)));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), noscApiDev()],
  optimizeDeps: { exclude: ["h5wasm"] },
  server: { fs: { strict: false } },
});
