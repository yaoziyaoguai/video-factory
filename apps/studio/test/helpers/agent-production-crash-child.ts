import { writeSync } from "node:fs";
import { productionHarness } from "./production-harness.js";
const [directory, time, point, local] = process.argv.slice(2);
let completedResults = 0;
const app = productionHarness(directory!, time!, reached => {
  if (local === "render" && reached === "after-result-commit" && completedResults++ === 0) return;
  if (reached === point) { writeSync(1, `crash:${reached}\n`); process.kill(process.pid, "SIGKILL"); }
}, local === "render");
app.accept();
await app.worker.pollOnce();
await app.worker.pollOnce();
await app.close();
throw new Error("fault point was not reached");
