import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store, Order, Touchpoint, AdSpend } from "../../apps/api/src/models";

let memory: MongoMemoryServer | undefined;

/**
 * Connects to TEST_MONGO_URL when set (CI uses a real mongo:7 service container), otherwise starts
 * an in-memory MongoDB. Each test file gets its own database so suites never share state.
 */
export async function connectTestMongo(dbName: string) {
  let uri = process.env.TEST_MONGO_URL;
  if (!uri) {
    memory = await MongoMemoryServer.create();
    uri = memory.getUri();
  }
  await mongoose.connect(uri, { dbName });
  await Promise.all([Store.syncIndexes(), Order.syncIndexes(), Touchpoint.syncIndexes(), AdSpend.syncIndexes()]);
}

export async function clearCollections() {
  await Promise.all([Store.deleteMany({}), Order.deleteMany({}), Touchpoint.deleteMany({}), AdSpend.deleteMany({})]);
}

export async function disconnectTestMongo() {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (memory) await memory.stop();
  memory = undefined;
}
