import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 与 server/.env 的 PORT 对齐，否则 /api 代理会打到错端口 */
function readServerPortFromEnvFile() {
  try {
    const envPath = path.join(__dirname, "server", ".env");
    const raw = fs.readFileSync(envPath, "utf8");
    const m = raw.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* ignore */
  }
  return 3000;
}

const apiTargetPort = readServerPortFromEnvFile();

export default defineConfig({
  root: "public",
  server: {
    port: 3050,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiTargetPort}`,
        changeOrigin: true,
      },
    },
  },
});

