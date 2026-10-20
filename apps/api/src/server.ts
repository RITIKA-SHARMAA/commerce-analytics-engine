import mongoose from "mongoose";
import { config } from "./config";
import { createApp } from "./app";
import { closeQueues } from "./queue";
import { logger } from "./logger";

async function main() {
  await mongoose.connect(config.mongoUrl);
  const runtime = createApp();
  const server = runtime.app.listen(config.port, () => logger.info({ port: config.port }, "API listening"));
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down API");
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeQueues(runtime.queues);
    await runtime.redis.quit();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(error => { logger.error({ err: error }, "API startup failed"); process.exit(1); });
