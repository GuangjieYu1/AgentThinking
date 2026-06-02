import { getConfig } from "./config.js";
import { AgentDatabase } from "./db.js";
import { createApp } from "./app.js";
import { IngestionQueue } from "./services/ingestion.js";
import { LibraryEventBus } from "./services/library-events.js";
import { createModelProvider } from "./services/models.js";
import { VectorStore } from "./services/vector-store.js";

const config = getConfig();
const db = new AgentDatabase(config.dataDir);
const vectors = new VectorStore(db);
const model = createModelProvider(config);
const events = new LibraryEventBus();
const queue = new IngestionQueue(db, vectors, model, config, events);
const app = await createApp({ config, db, vectors, model, queue, events });

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  db.close();
  process.exit(1);
}
