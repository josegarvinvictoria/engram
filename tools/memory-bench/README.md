# Behavioral A/B benchmark harness — Engram canonical-topic workflow

This directory contains a headless, isolated benchmark that runs the same
synthetic memory cases against two copies of the Pi Engram plugin (baseline vs.
PR) and reports literal A/B metrics.

## What is measured

For each arm, model, and case we record:

- **Passed** — did the run satisfy the case's literal pass rule?
- **Duplicates** — unexpected extra observations that collide with an existing
  topic_key/title.
- **Lost facts** — expected facts missing from the final topic content.
- **Wrong merges** — unrelated seed observations modified (ambiguous-identity)
  or facts lost.

## Limitations

- Synthetic prompts and literal string oracles.
- N=1 per scenario unless `--runs N` is increased.
- Model and thinking level are per-run configuration; results are not
  comparable across models.
- Commit under test: `feat/1449-canonical-topic-workflow` (`bfd38df`).
- The harness only compares plugin behavior; the server binary is the same for
  both arms.

## Prerequisites

- Node.js >=20
- `pi` 1.0.4+ in `PATH`
- A signed-in Pi agent config at `~/.pi/agent/auth.json`
- Go toolchain (to build the Engram server binary once)

## Build the server binary

```bash
go build -o tools/memory-bench/bin/engram ./cmd/engram
```

The binary is ignored by `.gitignore`.

## Prepare the arms

The runner takes two plugin paths and materializes temporary copies per run.
For PR #1653 the baseline is `upstream/main`:

```bash
cd /Users/josegarvinvictoria/Documents/Playgrounds/engram-1449
mkdir -p tools/memory-bench/tmp-baseline
git archive refs/remotes/upstream/main -- plugin/pi | tar -x -C tools/memory-bench/tmp-baseline
```

Then run with:

```bash
node tools/memory-bench/run.mjs \
  --arm-a tools/memory-bench/tmp-baseline/plugin/pi \
  --arm-b plugin/pi \
  --models opencode-go/deepseek-v4-flash \
  --output tools/memory-bench/results
```

## Dev smoke: one case per arm with deepseek-v4-flash

```bash
node tools/memory-bench/run.mjs \
  --arm-a tools/memory-bench/tmp-baseline/plugin/pi \
  --arm-b plugin/pi \
  --models opencode-go/deepseek-v4-flash \
  --cases enrichment,new-topic \
  --output tools/memory-bench/results
```

## Full A/B battery (ready for parent / CI)

```bash
node tools/memory-bench/run.mjs \
  --arm-a tools/memory-bench/tmp-baseline/plugin/pi \
  --arm-b plugin/pi \
  --models openai-codex/gpt-6-astra,openai-codex/gpt-5.6-sol \
  --output tools/memory-bench/results
```

Default thinking levels:

- `gpt-6-astra` → `low`
- `gpt-5.6-sol` → `medium`
- `deepseek-v4-flash` → `low`

Override with `--thinking low|medium|high|...`.

## Aggregate results

```bash
node tools/memory-bench/aggregate.mjs tools/memory-bench/results
```

Produces a markdown table:

```
| Arm | Cases | Passed | Duplicates | Lost facts | Wrong merges |
```

## Fixtures

`fixtures.mjs` defines six cases:

1. **new-topic** — empty seed, expects one deliberate `mem_save`.
2. **enrichment** — seed with F1/F2, prompt adds F3, expects `mem_update`.
3. **correction** — seed with F1 and a wrong fact W, prompt corrects to W2.
4. **already-covered** — seed already contains the learning, expects no writes.
5. **ambiguous-identity** — two similar topics, expects no write or an update
   of exactly one topic.
6. **failed-read** — seed one topic; the treatment arm's `GET /observations/{id}`
   returns 500 via `fault-proxy.mjs`, so it must not create or update. The
   baseline arm runs without the proxy and is recorded as a witness.

## Trace parsing

`pi -p --mode json` emits one JSON object per line. Tool calls appear as:

```json
{"type":"tool_execution_start","toolCallId":"...","toolName":"mem_search","args":{"query":"..."}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"mem_search","result":{...},"isError":false}
```

`evaluate.mjs` pairs these events and counts successful `mem_save`/`mem_update`
actions.

## Status (2026-10-12)

- Pipeline validated end-to-end with a dev model (`opencode-go/deepseek-v4-flash`, 6
  cases × 2 arms): runner, trace parsing, oracle, and aggregate all work; the dev
  numbers are a harness sanity check, **not** the official PR measurement.
- **Pending rerun:** the benchmark with the issue's exact model pair
  (`openai-codex/gpt-6-astra` at low thinking, `openai-codex/gpt-5.6-sol` at
  medium thinking) is blocked by the account's Codex usage limit
  (`Codex error: The usage limit has been reached`, reproduces on retry). It
  will be rerun as soon as the quota resets, with the exact command below; the
  harness marks any session that fails at the model layer as
  `MODEL_UNAVAILABLE` instead of emitting an invalid result.

## Generated artifacts

- `bin/engram` — built server binary.
- `tmp/` — temporary arm copies and per-scenario scratch dirs.
- `results/*.json` — one result file per arm×model×case×run.

All of the above are ignored by `.gitignore` and must not be committed.
