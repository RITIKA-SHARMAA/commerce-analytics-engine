import { Queue, Worker, QueueEvents, type Job } from "bullmq";
import type Redis from "ioredis";
import { routeExhaustedJobsToDeadLetter } from "../../apps/worker/src/processors";
import { testRedis, uniquePrefix } from "../helpers/redis";

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
};

describe("BullMQ retries and dead-letter routing (real Redis)", () => {
  let redis: Redis;
  let prefix: string;
  let work: Queue;
  let dead: Queue;
  let worker: Worker;
  let events: QueueEvents;
  const attemptsSeen = new Map<string, number>();
  const owned: Redis[] = [];

  beforeAll(async () => {
    redis = testRedis();
    prefix = uniquePrefix("dlq");
    const conn = () => {
      const connection = redis.duplicate();
      owned.push(connection);
      return { connection, prefix };
    };
    work = new Queue("work", { ...conn(), defaultJobOptions: { attempts: 3, backoff: { type: "fixed", delay: 20 }, removeOnFail: false } });
    dead = new Queue("dead", conn());
    events = new QueueEvents("work", conn());
    await events.waitUntilReady();
    worker = new Worker("work", async (job: Job) => {
      attemptsSeen.set(String(job.id), (attemptsSeen.get(String(job.id)) ?? 0) + 1);
      if (job.data.fail === "always") throw new Error("downstream unavailable");
      if (job.data.fail === "once" && job.attemptsMade === 0) throw new Error("transient");
      return "ok";
    }, conn());
    routeExhaustedJobsToDeadLetter(worker, dead);
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await work.obliterate({ force: true });
    await dead.obliterate({ force: true });
    await work.close();
    await dead.close();
    await Promise.all(owned.map(c => c.quit()));
    await redis.quit();
  });

  it("retries a failing job up to its attempt limit, then copies it to the dead-letter queue", async () => {
    const job = await work.add("order", { fail: "always", orderId: "o-1" });
    await waitFor(async () => (await dead.getJobCountByTypes("waiting")) === 1);
    expect(attemptsSeen.get(String(job.id))).toBe(3);
    const [deadJob] = await dead.getJobs(["waiting"]);
    expect(deadJob.data).toMatchObject({ originalJobId: job.id, name: "order", data: { orderId: "o-1" }, error: "downstream unavailable", attemptsMade: 3 });
  });

  it("does not dead-letter a job that succeeds on retry", async () => {
    const job = await work.add("order", { fail: "once" });
    await job.waitUntilFinished(events);
    expect(attemptsSeen.get(String(job.id))).toBe(2);
    expect(await dead.getJobCountByTypes("waiting")).toBe(1); // still only the job from the previous test
  });
});
