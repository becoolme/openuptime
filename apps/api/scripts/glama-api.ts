// Evaluator-only listener: the real Community routes, bound to loopback with no background scheduler.
import { serve } from "@hono/node-server";
import { openDatabase } from "@openuptime/db-pg";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";

const env = process.env as unknown as Bindings;
const database = openDatabase(env.DATABASE_URL!);
await database.migrate();
const app = createApp(() => ({ ...database, close: async () => {} }));
const server = serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: (request) => app.fetch(request, env),
});
const stop = () => {
  server.close();
  void database.close(5).finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
