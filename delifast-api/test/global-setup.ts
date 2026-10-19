import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * npm ci --ignore-scripts deliberately skips the binary pre-download. Warm it
 * once before Vitest starts workers: concurrent first downloads can race while
 * renaming the same .tgz.downloading archive on a clean CI runner.
 * Each suite still owns its isolated MongoDB instance and runs its real tests.
 */
export default async function prepareMongoBinary() {
  console.log("Préparation unique du binaire MongoDB avant les suites parallèles");
  const mongo = await MongoMemoryServer.create();
  await mongo.stop();
}
