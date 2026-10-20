import { Queue, type JobsOptions } from "bullmq";
import type Redis from "ioredis";

export const INGESTION_QUEUE = "commerce-ingestion";
export const SCHEDULED_QUEUE = "commerce-scheduled";
export const DEAD_LETTER_QUEUE = "commerce-dead-letter";

export const ingestionJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false
};

export type Queues = { ingestion: Queue; scheduled: Queue; deadLetter: Queue; connections: Redis[] };

/** BullMQ does not close connections it was handed, so each queue's duplicate is tracked and closed in closeQueues. */
export function createQueues(redis: Redis, prefix?: string): Queues {
  const connections: Redis[] = [];
  const opts = (defaultJobOptions?: JobsOptions) => {
    const connection = redis.duplicate();
    connections.push(connection);
    return { connection, prefix, defaultJobOptions };
  };
  return {
    ingestion: new Queue(INGESTION_QUEUE, opts(ingestionJobOptions)),
    scheduled: new Queue(SCHEDULED_QUEUE, opts({ attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100 })),
    deadLetter: new Queue(DEAD_LETTER_QUEUE, opts({ removeOnComplete: 1000 })),
    connections
  };
}

export async function closeQueues(queues: Queues) {
  await Promise.all([queues.ingestion.close(), queues.scheduled.close(), queues.deadLetter.close()]);
  await Promise.all(queues.connections.map(c => c.quit().catch(() => undefined)));
}
