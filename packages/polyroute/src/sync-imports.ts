// jco 0.24 sends every host import through its component-model-async runtime,
// even when both sides are synchronous. Each call creates a subtask on the
// guest's task, a second task for the host, and two closures, and saves and
// restores the current-task register. polyroute's host is synchronous WASI 0.2
// and never calls back into the guest, so none of that state is ever read. On
// a small route it's over half of the time a request takes.
//
// This rewrite wires each synchronous import straight to its trampoline and
// takes the task setup out of the trampoline. It keeps the checks that can
// fire: the may-leave check jco ran before the trampoline (now its first
// line), the trap checks around the host call, and the borrow release and
// `markTrapped` in the trampoline. docs/decisions/0002-skip-sync-task-bookkeeping.md
// explains why the rest is safe to drop.
//
// The patterns match jco's output exactly. An import whose code doesn't match
// keeps jco's code, and the test suite asserts every import of every fixture
// language is rewritten, so a jco release that changes its output fails CI
// instead of silently getting slower.

const LOWERED_IMPORT =
  /let (trampoline\d+) = _lowerImportBackwardsCompat\.bind\(null, _jcoTaskCompatImportContext, \{([\s\S]*?)importFn: (_trampoline\d+)\n\s*\}\);/g;

const SYNC_IMPORT_HEAD =
  /^\s*trampolineIdx: \d+,\s*componentIdx: (\d+),\s*isAsync: !1,\s*isManualAsync: (_trampoline\d+)\.manuallyAsync,/;

const SYNC_IMPORT_FLAGS =
  /\bfuncTypeIsAsync: !1,\s*getCallbackFn: \(\) => null,\s*getPostReturnFn: \(\) => null,/;

const TRAMPOLINE =
  /let (_trampoline\d+) = function\(([^)]*)\) \{\n([\s\S]*?)\n(\s*)\};\n(\s*)\1\.fnName = /g;

const TASK_SETUP = new RegExp(
  [
    String.raw`let parentTask;`,
    String.raw`let task;`,
    String.raw`let threadID;`,
    String.raw`let subtask;`,
    String.raw`let createTask = \(\) => \{`,
    String.raw`\(\{\s*task, threadID\s*\} = createNewCurrentImplicitThread\(_jcoTaskCreateContext, \{[^{}]*\}\)\);`,
    String.raw`\};`,
    String.raw`taskCreation: \{`,
    String.raw`parentTask = getCurrentTask\(_jcoTaskLookupContext, \d+, _getGlobalCurrentThreadMeta\(CURRENT_TASK_META, \d+\)\?\.taskID\)\?\.task;`,
    String.raw`if \(!parentTask\) \{`,
    String.raw`createTask\(\);`,
    String.raw`break taskCreation;`,
    String.raw`\}`,
    String.raw`createTask\(\);`,
    String.raw`subtask = parentTask\.getLatestSubtask\(\);`,
    String.raw`if \(!subtask\) throw Error\(` + "`[^`]*`" + String.raw`\);`,
    String.raw`task\.setParentSubtask\(subtask\);`,
    String.raw`\}`,
    String.raw`task\.enterSync\(\);`,
  ].join(String.raw`\n\s*`),
  "g",
);

const HOST_CALL =
  /_withGlobalCurrentThreadMeta\(CURRENT_TASK_META, \{\n\s*componentIdx: task\.componentIdx\(\),\n\s*taskID: task\.id\(\),\n\s*threadID,\n\s*fn: \(\) => (_trackHostOperation\(_jcoComponentHostOperationContext, \(\) => .*\))\n\s*\}\)/g;

const RETURNS_VALUE = /task\.resolve\(\[(.+)\]\);\n\s*task\.exit\(\);\n\s*return (.+);$/;
const RETURNS_NOTHING = /task\.resolve\(\[ret\]\);\n\s*task\.exit\(\);$/;

const CHECK_MAY_LEAVE = "__jcoEmbeddedRuntime$checkMayLeave";
const HOST_TASK = "__polyrouteSyncHostTask";

// What the trampoline still calls on `task` after the rewrite: completion at
// the end and the error path. None of it has an effect without a real task.
const HOST_TASK_METHODS = new Set([
  "id",
  "getParentSubtask",
  "setErrored",
  "reject",
  "resolve",
  "exit",
]);
const HOST_TASK_SOURCE = `const ${HOST_TASK} = Object.freeze({ ${[...HOST_TASK_METHODS].map((name) => `${name}() {}`).join(", ")} });\n`;

type ResultShape = "value" | "pointer" | "none";

interface SyncImport {
  componentIdx: string;
  result: ResultShape;
}

export interface SyncImportRewrite {
  bindings: string;
  /** Imports wired straight to their trampolines. */
  rewritten: number;
  /** Imports jco lowered through its async task runtime. */
  lowered: number;
}

export function skipSyncTaskBookkeeping(bindings: string): SyncImportRewrite {
  const imports = [...bindings.matchAll(LOWERED_IMPORT)];
  const unchanged = { bindings, rewritten: 0, lowered: imports.length };
  if (
    imports.length === 0 ||
    !bindings.includes(`function ${CHECK_MAY_LEAVE}(`) ||
    /\.manuallyAsync\s*=(?!=)/.test(bindings)
  ) {
    return unchanged;
  }

  const references = new Map<string, number>();
  for (const [, , , target] of imports) {
    references.set(target!, (references.get(target!) ?? 0) + 1);
  }
  const sync = new Map<string, SyncImport>();
  for (const [, , options, target] of imports) {
    const head = SYNC_IMPORT_HEAD.exec(options!);
    if (
      head === null ||
      head[2] !== target ||
      references.get(target!) !== 1 ||
      options!.includes("_lowerImportBackwardsCompat.bind(") ||
      !SYNC_IMPORT_FLAGS.test(options!)
    ) {
      continue;
    }
    const result: ResultShape = /\bhasResultPointer: !0,/.test(options!)
      ? "pointer"
      : /\bresultLowerFns: \[\],/.test(options!)
        ? "none"
        : "value";
    sync.set(target!, { componentIdx: head[1]!, result });
  }

  const rewritten = new Set<string>();
  let out = bindings.replace(
    TRAMPOLINE,
    (whole, name: string, params: string, body: string, close: string, next: string) => {
      const entry = sync.get(name);
      const thin = entry === undefined ? undefined : thinTrampoline(body, close, entry);
      if (thin === undefined) return whole;
      rewritten.add(name);
      return `let ${name} = function(${params}) {\n${thin}\n${close}};\n${next}${name}.fnName = `;
    },
  );
  if (rewritten.size === 0) return unchanged;

  out = out.replace(LOWERED_IMPORT, (whole, name: string, _options: string, target: string) =>
    rewritten.has(target) ? `let ${name} = ${target};` : whole,
  );
  return { bindings: HOST_TASK_SOURCE + out, rewritten: rewritten.size, lowered: imports.length };
}

function thinTrampoline(body: string, close: string, entry: SyncImport): string | undefined {
  const returns = RETURNS_VALUE.exec(body);
  const shapeMatches =
    entry.result === "value"
      ? returns !== null && returns[1] === returns[2]
      : returns === null && RETURNS_NOTHING.test(body);
  if (!shapeMatches) return undefined;
  if (count(body, TASK_SETUP) !== 1 || count(body, HOST_CALL) !== 1) return undefined;

  const thin = body
    .replace(TASK_SETUP, () => `const task = ${HOST_TASK};`)
    .replace(HOST_CALL, (_whole, call: string) => call);
  for (const [, method] of thin.matchAll(/\btask\.(\w+)\(/g)) {
    if (!HOST_TASK_METHODS.has(method!)) return undefined;
  }
  if (/(?<![.\w$])threadID\b/.test(thin)) return undefined;
  return `${close}\t${CHECK_MAY_LEAVE}(_jcoTaskCompatImportContext.mayLeave, ${entry.componentIdx});\n${thin}`;
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}
