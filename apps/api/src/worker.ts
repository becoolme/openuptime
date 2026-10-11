import type { OpenDatabase } from "@openuptime/repo";
import { openDatabase } from "@openuptime/db-pg";
import { createApp } from "./app";
import { configureEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { connectionString, type Bindings } from "./env";
import { processCheckMessage, runDueChecks, type CheckMessage } from "./scheduler";

// the one place that picks the storage backend
const open: OpenDatabase = openDatabase;
// ...and the one place that picks the edition: the hosted one passes its own metering here
const entitlements: Entitlements = unmetered;
const app = createApp(open, { entitlements });

export default {
  fetch: app.fetch,

  // Cron Trigger (`* * * * *`): lease due monitors and fan them out to CHECK_QUEUE.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    configureEmail(env);
    const database = open(connectionString(env), { max: 2 });
    ctx.waitUntil(runDueChecks(database.repo, env.CHECK_QUEUE, entitlements).finally(() => database.close(5)));
  },

  // Queue consumer: each message is a pack of monitor ids, handled in its own invocation.
  async queue(batch: MessageBatch<CheckMessage>, env: Bindings) {
    configureEmail(env);
    const database = open(connectionString(env), { max: 5 });
    try {
      for (const msg of batch.messages) {
        try {
          await processCheckMessage(database.repo, msg.body, entitlements);
          msg.ack();
        } catch (e) {
          console.error("check batch failed", e);
          msg.retry({ delaySeconds: 10 });
        }
      }
    } finally {
      await database.close(5);
    }
  },
} satisfies ExportedHandler<Bindings, CheckMessage>;
