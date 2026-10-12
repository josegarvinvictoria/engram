#!/usr/bin/env node
// A/B behavioral benchmark runner for Engram canonical-topic workflow.
//
// Usage (from repo root):
//   node tools/memory-bench/run.mjs \
//     --arm-a <path-to-baseline-plugin/pi> \
//     --arm-b <path-to-pr-plugin/pi> \
//     --models opencode-go/deepseek-v4-flash \
//     --cases enrichment,new-topic \
//     --output tools/memory-bench/results
//
// The runner materializes temporary copies of the two arms, starts an isolated
// Engram server per scenario, seeds the case, runs `pi -p --mode json`, and
// writes one JSON result per arm×model×case×run.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { fixtures, PROJECT } from "./fixtures.mjs";
import { parseActions, evaluateCase } from "./evaluate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const AUTH_SOURCE = path.join(os.homedir(), ".pi", "agent", "auth.json");

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function eventModelError(events) {
  for (const ev of events) {
    if (ev?.type === "message_end" || ev?.type === "turn_end") {
      const m = ev.message;
      if (m && m.stopReason === "error") {
        return m.errorMessage || "model error";
      }
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = {
    armA: undefined,
    armB: undefined,
    models: ["opencode-go/deepseek-v4-flash"],
    cases: undefined,
    output: path.join(REPO_ROOT, "tools", "memory-bench", "results"),
    bin: path.join(REPO_ROOT, "tools", "memory-bench", "bin", "engram"),
    tempRoot: path.join(REPO_ROOT, "tools", "memory-bench", "tmp"),
    runs: 1,
    thinking: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--arm-a") args.armA = val;
    else if (key === "--arm-b") args.armB = val;
    else if (key === "--models") args.models = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "--cases") args.cases = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "--output") args.output = path.resolve(REPO_ROOT, val);
    else if (key === "--bin") args.bin = path.resolve(REPO_ROOT, val);
    else if (key === "--temp-root") args.tempRoot = path.resolve(REPO_ROOT, val);
    else if (key === "--runs") args.runs = Number.parseInt(val, 10);
    else if (key === "--thinking") args.thinking = val;
    else if (key === "--help" || key === "-h") {
      process.stdout.write(`Usage: node tools/memory-bench/run.mjs --arm-a <dir> --arm-b <dir> [options]\n`);
      process.exit(0);
    }
  }
  return args;
}

function defaultThinking(model) {
  if (model.includes("gpt-6-astra")) return "low";
  if (model.includes("gpt-5.6-sol")) return "medium";
  return "low";
}

function providerFromModel(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort; temp dirs are ignored by git.
  }
}

function ensureBinary(binPath) {
  if (fs.existsSync(binPath)) return;
  process.stderr.write(`Building Engram binary at ${binPath}\n`);
  const r = spawnSync("go", ["build", "-o", binPath, "./cmd/engram"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) die(`go build failed with status ${r.status}`);
}

function copyPlugin(srcDir, dstDir) {
  ensureDir(dstDir);
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server health check timeout"));
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

function killProc(proc, label) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {}
  }, 2000);
}

async function startServer({ binPath, dataDir, port, logPath }) {
  ensureDir(dataDir);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const proc = spawn(binPath, ["serve", String(port)], {
    env: {
      ...process.env,
      ENGRAM_DATA_DIR: dataDir,
      ENGRAM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.pipe(log, { end: false });
  proc.stderr.pipe(log, { end: false });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/health`);
  return { proc, url, log };
}

async function startFaultProxy({ targetUrl, faultPath, logPath }) {
  const port = await pickFreePort();
  const log = fs.createWriteStream(logPath, { flags: "a" });
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      path.join(__dirname, "fault-proxy.mjs"),
      "--target", targetUrl,
      "--port", String(port),
      "--fault-method", "GET",
      "--fault-path", faultPath,
      "--log", logPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let captured = false;
    proc.stdout.on("data", (chunk) => {
      if (captured) return;
      captured = true;
      const proxyPort = Number.parseInt(chunk.toString().trim(), 10);
      resolve({ proc, url: `http://127.0.0.1:${proxyPort}`, port: proxyPort, log });
    });
    proc.stderr.pipe(log, { end: false });
    proc.on("exit", (code) => {
      if (!captured) reject(new Error(`fault proxy exited early: ${code}`));
    });
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function seedObservations(serverUrl, seeds) {
  const sessionId = `bench-session-${Math.random().toString(36).slice(2, 8)}`;
  await postJson(`${serverUrl}/sessions`, { id: sessionId, project: PROJECT });
  const initial = [];
  for (const seed of seeds) {
    const created = await postJson(`${serverUrl}/observations`, {
      session_id: sessionId,
      type: seed.type || "decision",
      title: seed.title,
      content: seed.content,
      topic_key: seed.topic_key || "",
      scope: seed.scope || "project",
      project: PROJECT,
    });
    initial.push({
      id: created.id,
      title: seed.title,
      topic_key: seed.topic_key || "",
      content: seed.content,
      type: seed.type || "decision",
      scope: seed.scope || "project",
    });
  }
  return initial;
}

async function readFinalObservations(serverUrl) {
  const url = `${serverUrl}/observations/recent?project=${encodeURIComponent(PROJECT)}&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recent observations failed: ${res.status}`);
  return await res.json();
}

function writeAgentSettings(agentDir, model) {
  const settings = {
    defaultModel: model,
    defaultProvider: providerFromModel(model),
    defaultThinkingLevel: defaultThinking(model),
    packages: [],
    extensions: [],
  };
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function runPi({ armDir, projectDir, agentDir, model, thinking, promptFile, tracePath, stderrPath, engramUrl }) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    ENGRAM_URL: engramUrl,
    ENGRAM_STARTUP_POLICY: "allow",
  };

  return new Promise((resolve, reject) => {
    const proc = spawn("pi", [
      "-p",
      "--mode", "json",
      "--no-skills",
      "--no-mcp",
      "--no-context-files",
      "--no-session",
      "--no-extensions",
      "-e", path.join(armDir, "index.ts"),
      "--tools", "mem_search,mem_get_observation,mem_save,mem_update",
      "--model", model,
      "--thinking", thinking || defaultThinking(model),
      "--", `@${promptFile}`,
    ], {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = fs.createWriteStream(tracePath);
    const err = fs.createWriteStream(stderrPath);
    proc.stdout.pipe(out);
    proc.stderr.pipe(err);

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 120000);

    proc.on("error", reject);
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
  });
}

async function runScenario({
  arm,
  armDir,
  model,
  thinking,
  caseDef,
  runIdx,
  binPath,
  outputDir,
  tempRoot,
}) {
  const startedAt = Date.now();
  const scenarioDir = fs.mkdtempSync(path.join(tempRoot, `scenario-${arm}-${caseDef.id}-`));
  const agentDir = path.join(scenarioDir, "agent");
  const projectDir = path.join(scenarioDir, "project");
  const dataDir = path.join(scenarioDir, "data");
  const tracePath = path.join(scenarioDir, "pi.jsonl");
  const stderrPath = path.join(scenarioDir, "pi.err");
  const serverLogPath = path.join(scenarioDir, "server.log");
  const proxyLogPath = path.join(scenarioDir, "proxy.log");

  let server;
  let proxy;
  try {
    ensureDir(agentDir);
    ensureDir(path.join(projectDir, ".engram"));
    fs.writeFileSync(path.join(projectDir, ".engram", "config.json"), JSON.stringify({ project_name: PROJECT }));
    fs.cpSync(AUTH_SOURCE, path.join(agentDir, "auth.json"));
    writeAgentSettings(agentDir, model);

    const port = await pickFreePort();
    server = await startServer({ binPath, dataDir, port, logPath: serverLogPath });

    const initialObservations = await seedObservations(server.url, caseDef.seeds || []);

    let pluginUrl = server.url;
    if (caseDef.faultProxy && arm === "B") {
      const seedId = initialObservations[0]?.id;
      proxy = await startFaultProxy({
        targetUrl: server.url,
        faultPath: `/observations/${seedId}`,
        logPath: proxyLogPath,
      });
      pluginUrl = proxy.url;
    }

    const promptFile = path.join(scenarioDir, "prompt.txt");
    fs.writeFileSync(promptFile, caseDef.prompt);

    // ENGRAM_URL must point to the plugin-facing endpoint (proxy or server).
    await runPi({
      armDir,
      projectDir,
      agentDir,
      model,
      thinking,
      promptFile,
      tracePath,
      stderrPath,
      engramUrl: pluginUrl,
    });

    const finalObservations = await readFinalObservations(server.url);

    const events = [];
    try {
      const text = fs.readFileSync(tracePath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // Non-JSON lines are ignored.
        }
      }
    } catch {}

    const modelError = eventModelError(events);
    if (modelError) {
      const modelResult = {
        timestamp: new Date().toISOString(),
        arm,
        model,
        caseId: caseDef.id,
        caseName: caseDef.name,
        runIdx,
        status: "model_unavailable",
        modelError,
        actions: [],
        initialObservations,
        finalObservations,
        durationMs: Date.now() - startedAt,
        paths: { scenarioDir, tracePath, stderrPath, serverLogPath, proxyLogPath },
      };
      const errName = `${modelResult.timestamp.replace(/[:.]/g, "-")}-${arm}-${model.replace(/[^a-zA-Z0-9._-]/g, "_")}-${caseDef.id}-${runIdx}.json`;
      fs.writeFileSync(path.join(outputDir, errName), JSON.stringify(modelResult, null, 2));
      process.stderr.write(`  ${arm} ${model} ${caseDef.id} run ${runIdx}: MODEL_UNAVAILABLE ${modelError}\n`);
      return;
    }

    const actions = parseActions(events);
    const { passed, metrics } = evaluateCase({
      caseDef,
      arm,
      actions,
      initialObservations,
      finalObservations,
    });

    const timestamp = new Date().toISOString();
    const result = {
      timestamp,
      arm,
      model,
      caseId: caseDef.id,
      caseName: caseDef.name,
      runIdx,
      passed,
      metrics,
      actions: actions.map((a) => ({
        toolName: a.toolName,
        args: a.args,
        isError: a.isError,
        createdId: a.toolName === "mem_save" ? (a.result?.details?.data?.id ?? null) : null,
        updatedId: a.toolName === "mem_update" ? (a.args?.id ?? null) : null,
      })),
      initialObservations,
      finalObservations,
      durationMs: Date.now() - startedAt,
      paths: {
        scenarioDir,
        tracePath,
        stderrPath,
        serverLogPath,
        proxyLogPath,
      },
    };

    const outName = `${timestamp.replace(/[:.]/g, "-")}-${arm}-${model.replace(/[^a-zA-Z0-9._-]/g, "_")}-${caseDef.id}-${runIdx}.json`;
    const outPath = path.join(outputDir, outName);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    process.stderr.write(
      `  ${arm} ${model} ${caseDef.id} run ${runIdx}: ` +
      `${passed ? "PASS" : "FAIL"} saves=${metrics.saves} updates=${metrics.updates} ` +
      `dup=${metrics.duplicates} lost=${metrics.lostFacts} wrong=${metrics.wrongMerges}\n`
    );

    return result;
  } finally {
    if (proxy) killProc(proxy.proc, "proxy");
    if (server) {
      try {
        server.log.end();
      } catch {}
      killProc(server.proc, "server");
    }
    // Keep the scenario dir for debugging; it lives under tmp/ which is ignored.
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.armA || !args.armB) die("--arm-a and --arm-b are required");
  if (!fs.existsSync(path.join(args.armA, "index.ts"))) die(`missing ${args.armA}/index.ts`);
  if (!fs.existsSync(path.join(args.armB, "index.ts"))) die(`missing ${args.armB}/index.ts`);
  if (!fs.existsSync(AUTH_SOURCE)) die(`missing ${AUTH_SOURCE}; copy Pi auth.json or sign in`);

  ensureBinary(args.bin);
  ensureDir(args.output);
  ensureDir(args.tempRoot);

  const runDir = fs.mkdtempSync(path.join(args.tempRoot, "run-"));
  const armADir = path.join(runDir, "A");
  const armBDir = path.join(runDir, "B");
  copyPlugin(args.armA, armADir);
  copyPlugin(args.armB, armBDir);

  const selectedCases = args.cases
    ? fixtures.filter((c) => args.cases.includes(c.id))
    : fixtures;
  if (selectedCases.length === 0) die("no matching cases");

  const arms = [
    { label: "A", dir: armADir },
    { label: "B", dir: armBDir },
  ];

  process.stderr.write(
    `Running ${selectedCases.length} cases × ${args.models.length} models × ${args.runs} run(s)\n` +
    `Output: ${args.output}\nTemp:   ${runDir}\n`
  );

  const results = [];
  for (const model of args.models) {
    for (const { label, dir } of arms) {
      for (const caseDef of selectedCases) {
        for (let r = 1; r <= args.runs; r += 1) {
          const result = await runScenario({
            arm: label,
            armDir: dir,
            model,
            thinking: args.thinking,
            caseDef,
            runIdx: r,
            binPath: args.bin,
            outputDir: args.output,
            tempRoot: runDir,
          });
          results.push(result);
        }
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  process.stderr.write(`\nDone. ${passed}/${results.length} scenarios passed.\n`);
}

main().catch((err) => {
  die(err.stack || err.message);
});
