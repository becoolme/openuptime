import type { OpenDatabase } from "@openuptime/repo";
import { openDatabase } from "@openuptime/db-pg";
import { createApp } from "./app";
import { configureEmail } from "./email";
import { configureNetGuard } from "./netguard";
import { configureProbes } from "./probes";
import { community, type Edition } from "./edition";
import { connectionString, type Bindings } from "./env";
import { processCheckMessage, runDueChecks, type CheckMessage } from "./scheduler";

// the one place that picks the storage backend
const open: OpenDatabase = openDatabase;

/** A Worker for an edition. This file runs the open-source one; the hosted entry point calls this with its own. */
export function createWorker(edition: Edition = community) {
  const app = createApp(open, { edition });
  return {
    fetch: app.fetch,

    // Cron Trigger (`* * * * *`): lease due monitors and fan them out to CHECK_QUEUE.
    async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
      configureEmail(env);
      configureNetGuard(env);
      configureProbes(env);
      const database = open(connectionString(env), { max: 2 });
      ctx.waitUntil(runDueChecks(database.repo, env.CHECK_QUEUE, edition.entitlements({ database, env })).finally(() => database.close(5)));
    },

    // Queue consumer: each message is a pack of monitor ids, handled in its own invocation.
    async queue(batch: MessageBatch<CheckMessage>, env: Bindings) {
      configureEmail(env);
      configureNetGuard(env);
      configureProbes(env);
      const database = open(connectionString(env), { max: 5 });
      const entitlements = edition.entitlements({ database, env });
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
}

export default createWorker();
