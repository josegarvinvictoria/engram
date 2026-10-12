// Literal oracle for the behavioral A/B benchmark.
// Knows nothing about intent; it only counts actions and greps final content.

const WRITE_TOOLS = new Set(["mem_save", "mem_update"]);
const SESSION_SUMMARY_TYPE = "session_summary";

export function parseActions(events) {
  const byId = new Map();
  const actions = [];
  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "tool_execution_start") {
      byId.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args ?? {},
        result: undefined,
        isError: false,
      });
    } else if (ev.type === "tool_execution_end") {
      const a = byId.get(ev.toolCallId);
      if (!a) continue;
      a.result = ev.result;
      a.isError = Boolean(ev.isError);
      if (WRITE_TOOLS.has(a.toolName)) actions.push(a);
    }
  }
  return actions;
}

function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesFact(content, fact) {
  return normalize(content).includes(normalize(fact));
}

function filterRelevant(observations) {
  // Session-summary observations written by lifecycle hooks are not part of the
  // case contract; drop them before counting duplicates or merges.
  return observations.filter((o) => o.type !== SESSION_SUMMARY_TYPE);
}

function createdObservationId(action) {
  // Successful mem_save returns the saved observation in result.details.data.id
  const data = action?.result?.details?.data;
  if (data && typeof data === "object" && typeof data.id === "number") return data.id;
  return undefined;
}

function updatedObservationId(action) {
  return action?.toolName === "mem_update" && action.args && typeof action.args.id === "number"
    ? action.args.id
    : undefined;
}

function relevantContents({ caseDef, actions, initialObservations, finalObservations }) {
  const initialById = new Map(initialObservations.map((o) => [o.id, o]));
  const finalById = new Map(finalObservations.map((o) => [o.id, o]));

  const saveIds = [];
  const updateIds = [];
  for (const a of actions) {
    if (a.isError) continue;
    if (a.toolName === "mem_save") {
      const id = createdObservationId(a);
      if (id !== undefined) saveIds.push(id);
    } else if (a.toolName === "mem_update") {
      const id = updatedObservationId(a);
      if (id !== undefined) updateIds.push(id);
    }
  }

  if (caseDef.id === "new-topic") {
    // The newly saved observation(s) carry the expected facts.
    return saveIds.map((id) => finalById.get(id)).filter(Boolean).map((o) => o.content);
  }

  if (initialObservations.length === 1) {
    // For single-seed cases the relevant topic is the seed itself, updated or not.
    const id = initialObservations[0].id;
    const fin = finalById.get(id);
    return fin ? [fin.content] : [];
  }

  // Multi-seed cases (ambiguous-identity): union of all seed final contents.
  return initialObservations
    .map((o) => finalById.get(o.id))
    .filter(Boolean)
    .map((o) => o.content);
}

function countLostFacts(caseDef, contents) {
  if (!caseDef.expectedFacts || caseDef.expectedFacts.length === 0) return 0;
  let lost = 0;
  const union = contents.join("\n");
  for (const fact of caseDef.expectedFacts) {
    if (!includesFact(union, fact)) lost += 1;
  }
  return lost;
}

function countDuplicates({ caseDef, initialObservations, finalObservations, actions }) {
  const initialIds = new Set(initialObservations.map((o) => o.id));
  const newObs = finalObservations.filter((o) => !initialIds.has(o.id));

  if (caseDef.id === "new-topic") {
    // One new observation is expected; every additional one is a duplicate.
    return Math.max(0, newObs.length - 1);
  }

  // For every other case, any unexpected new observation is a duplicate.
  return newObs.length;
}

function countWrongMerges({ caseDef, initialObservations, finalObservations, actions }) {
  if (caseDef.id !== "ambiguous-identity") return 0;

  const initialById = new Map(initialObservations.map((o) => [o.id, o]));
  const finalById = new Map(finalObservations.map((o) => [o.id, o]));
  const updatedIds = new Set(
    actions
      .filter((a) => a.toolName === "mem_update" && !a.isError)
      .map((a) => updatedObservationId(a))
      .filter((id) => id !== undefined)
  );

  let wrong = 0;
  const changedIds = [];
  for (const init of initialObservations) {
    const fin = finalById.get(init.id);
    if (!fin) continue;
    const changed = normalize(fin.content) !== normalize(init.content);
    if (!changed) continue;
    changedIds.push(init.id);
    // A changed seed that was not produced by a tracked update is suspicious.
    if (!updatedIds.has(init.id)) wrong += 1;
  }

  // Updating more than one ambiguous candidate is a merge across topics.
  if (changedIds.length > 1) {
    wrong += changedIds.length - 1;
  }

  return wrong;
}

export function countActions(actions) {
  let saves = 0;
  let updates = 0;
  for (const a of actions) {
    if (a.isError) continue;
    if (a.toolName === "mem_save") saves += 1;
    else if (a.toolName === "mem_update") updates += 1;
  }
  return { saves, updates };
}

export function evaluateCase({ caseDef, arm, actions, initialObservations, finalObservations }) {
  const filteredFinal = filterRelevant(finalObservations);
  const { saves, updates } = countActions(actions);
  const contents = relevantContents({
    caseDef,
    actions,
    initialObservations,
    finalObservations: filteredFinal,
  });
  const lostFacts = countLostFacts(caseDef, contents);
  const duplicates = countDuplicates({
    caseDef,
    initialObservations,
    finalObservations: filteredFinal,
    actions,
  });
  const wrongMerges = countWrongMerges({
    caseDef,
    initialObservations,
    finalObservations: filteredFinal,
    actions,
  });

  const metrics = { saves, updates, lostFacts, duplicates, wrongMerges };
  const pass = caseDef.pass({ ...metrics, arm, actions, initialObservations, finalObservations: filteredFinal });

  return {
    passed: Boolean(pass),
    metrics,
  };
}

export default evaluateCase;
