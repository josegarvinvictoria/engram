#!/usr/bin/env node
// Aggregates per-run result JSON files into an A/B table.
//
// Usage:
//   node tools/memory-bench/aggregate.mjs [results-dir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS = path.join(__dirname, "results");

function loadResults(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((r) => typeof r.passed === "boolean");
}

function slugModel(model) {
  return model.replace(/.*\//, "");
}

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_RESULTS;
  if (!fs.existsSync(dir)) {
    process.stderr.write(`Results directory not found: ${dir}\n`);
    process.exit(1);
  }

  const results = loadResults(dir);
  if (results.length === 0) {
    process.stderr.write(`No result JSON files in ${dir}\n`);
    process.exit(1);
  }

  // Per-model A/B summary.
  const byModel = new Map();
  for (const r of results) {
    const key = r.model;
    if (!byModel.has(key)) byModel.set(key, { A: [], B: [] });
    byModel.get(key)[r.arm].push(r);
  }

  process.stdout.write(`# Behavioral A/B results (${results.length} scenarios)\n\n`);

  for (const [model, arms] of byModel) {
    process.stdout.write(`## Model: ${model}\n\n`);
    process.stdout.write(`| Arm | Cases | Passed | Duplicates | Lost facts | Wrong merges |\n`);
    process.stdout.write(`| --- | ----- | ------ | ---------- | ---------- | ------------ |\n`);
    for (const arm of ["A", "B"]) {
      const rows = arms[arm];
      const cases = rows.length;
      const passed = rows.filter((r) => r.passed).length;
      const duplicates = rows.reduce((s, r) => s + r.metrics.duplicates, 0);
      const lost = rows.reduce((s, r) => s + r.metrics.lostFacts, 0);
      const wrong = rows.reduce((s, r) => s + r.metrics.wrongMerges, 0);
      process.stdout.write(`| ${arm} | ${cases} | ${passed} | ${duplicates} | ${lost} | ${wrong} |\n`);
    }
    process.stdout.write(`\n`);
  }

  // Detail by case/model/arm.
  process.stdout.write(`## Detail\n\n`);
  process.stdout.write(`| Model | Arm | Case | Passed | Saves | Updates | Dup | Lost | Wrong |\n`);
  process.stdout.write(`| ----- | --- | ---- | ------ | ----- | ------- | --- | ---- | ----- |\n`);
  for (const r of results.sort((a, b) => {
    if (a.model !== b.model) return a.model.localeCompare(b.model);
    if (a.arm !== b.arm) return a.arm.localeCompare(b.arm);
    return a.caseId.localeCompare(b.caseId);
  })) {
    const m = r.metrics;
    process.stdout.write(
      `| ${slugModel(r.model)} | ${r.arm} | ${r.caseId} | ${r.passed ? "✓" : "✗"} | ` +
      `${m.saves} | ${m.updates} | ${m.duplicates} | ${m.lostFacts} | ${m.wrongMerges} |\n`
    );
  }
}

main();
