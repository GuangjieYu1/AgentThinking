import { getConfig } from "./config.js";
import { AgentDatabase } from "./db.js";

const versionId = process.argv[2];
if (!versionId) {
  console.error("Usage: npm run debug:index-status -- <versionId>");
  process.exit(1);
}

const config = getConfig();
const db = new AgentDatabase(config.dataDir);
try {
  console.log(JSON.stringify(db.getIndexStatusReport(versionId), null, 2));
} finally {
  db.close();
}
