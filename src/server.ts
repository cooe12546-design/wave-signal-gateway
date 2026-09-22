import "dotenv/config";
import Fastify from "fastify";
import { openDatabase } from "./lib/db.js";
import { healthRoute } from "./routes/health.js";
import { signalEventsRoute } from "./routes/signal-events.js";
import { lineTestRoute } from "./routes/line-test.js";
import { lineWebhookRoute } from "./routes/line-webhook.js";
import { deliveriesInspectionRoute } from "./routes/deliveries-inspection.js";
import { logger } from "./lib/logger.js";
import { loadLineSenderConfig } from "./lib/line-config.js";
import { runDueDeliveries } from "./lib/deliveries.js";
import type Database from "better-sqlite3";

// L5 §6: lightweight in-process retry sweep -- no external queue, no
// Redis, no cron dependency. Interval is explicit and configurable;
// startup behavior is deterministic (first sweep fires after one full
// interval, not immediately on boot, to give the process a moment to
// settle); stops cleanly on shutdown via the returned handle.
const DELIVERY_SWEEP_INTERVAL_MS = Number(process.env.DELIVERY_SWEEP_INTERVAL_MS ?? 15_000);

function startDeliverySweep(db: Database.Database): NodeJS.Timeout {
  const lineConfig = loadLineSenderConfig();
  return setInterval(() => {
    runDueDeliveries(db, lineConfig).catch((err) => {
      logger.error("delivery.sweep_error", { message: err instanceof Error ? err.message : String(err) });
    });
  }, DELIVERY_SWEEP_INTERVAL_MS);
}

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
  app.register(deliveriesInspectionRoute, { db, apiKey: process.env.SIGNAL_EVENT_API_KEY });

  const sweepHandle = startDeliverySweep(db);

  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweepHandle);
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
