import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(child, url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await delay(50);
  }
  throw new Error("Server did not become ready in time");
}

async function withServer(run) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(child, BASE);
    await run();
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(1000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (stderr.trim()) process.stderr.write(stderr);
  }
}

async function triage(text) {
  const response = await fetch(`${BASE}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: response.status, body: await response.json() };
}

test("model failure returns manual_review without draft", async () => {
  await withServer(async () => {
    const { status, body } = await triage("Нужна помощь [error]");
    assert.equal(status, 200);
    assert.deepEqual(body, {
      status: "manual_review",
      topic: null,
      draft: null,
    });
  });
});

test("model timeout returns manual_review", async () => {
  await withServer(async () => {
    const { status, body } = await triage("Проверьте статус [timeout]");
    assert.equal(status, 200);
    assert.deepEqual(body, {
      status: "manual_review",
      topic: null,
      draft: null,
    });
  });
});

test("invalid input returns 400", async () => {
  await withServer(async () => {
    const response = await fetch(`${BASE}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  });
});

test("ready response returns topic and draft", async () => {
  await withServer(async () => {
    const { status, body } = await triage("Когда будет доставка заказа?");
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.equal(typeof body.draft, "string");
    assert.ok(body.draft.trim().length > 0);
  });
});
