import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const api = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.mjs"], {
  cwd: root,
  stdio: "inherit",
});
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  cwd: root,
  stdio: "inherit",
});

function stop() {
  api.kill();
  vite.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  vite.kill();
});
vite.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  api.kill();
});
