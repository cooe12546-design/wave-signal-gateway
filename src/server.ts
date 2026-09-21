import "dotenv/config";
import Fastify from "fastify";
import { openDatabase } from "./lib/db.js";
import { healthRoute } from "./routes/health.js";
import { signalEventsRoute } from "./routes/signal-events.js";
import { lineTestRoute } from "./routes/line-test.js";
import { lineWebhookRoute } from "./routes/line-webhook.js";
import { logger } from "./lib/logger.js";

export function buildServer() {
  const app = Fastify({ logger: false }); // structured logging is handled by src/lib/logger.ts, not Fastify's own logger, to keep one consistent log shape and one place secrets can never leak from

  const dbPath = process.env.DATABASE_PATH ?? "./data/wave-signal-gateway.db";
  const db = openDatabase(dbPath);

  app.register(healthRoute);
  app.register(signalEventsRoute, { db, apiKey: process.env.SIGNAL_EVENT_API_KEY });
  app.register(lineTestRoute, { apiKey: process.env.SIGNAL_EVENT_API_KEY });
  // Registered as its own plugin so its scoped raw-body content-type parser
  // (needed for HMAC signature verification, brief §3) stays isolated to
  // this one route via Fastify's plugin encapsulation -- it does not affect
  // JSON body parsing on any other route registered above.
  app.register(lineWebhookRoute, { channelSecret: process.env.LINE_CHANNEL_SECRET });

  app.addHook("onClose", (_instance, done) => {
    db.close();
    done();
  });

  return app;
}

async function main() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ port, host: "0.0.0.0" });
    logger.info("server.started", { port });
  } catch (err) {
    logger.error("server.start_failed", { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by the self-test harness)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
