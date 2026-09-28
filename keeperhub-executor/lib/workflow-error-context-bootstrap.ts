/**
 * Register the async-local workflow error context storage for a non-Next.js
 * process (the executor, the k8s workflow-runner, and the runner bootstrap).
 *
 * `lib/workflow/executor/error-context.ts` deliberately holds no Node
 * builtins, because the Workflow DevKit bundles it; the actual
 * AsyncLocalStorage instance is normally registered from `instrumentation.ts`
 * behind `process.env.NEXT_RUNTIME === "nodejs"`. Neither the executor stage
 * nor the workflow-runner stage of the Dockerfile copies `instrumentation.ts`
 * (they build from a bare node:24-alpine and run via tsx), so without this
 * module the storage stays null in production, `getWorkflowErrorContext()`
 * always returns undefined, and every caller degrades silently:
 *
 *  - markBroadcast() cannot resolve its execution id, so the broadcast
 *    sidecar is never written and executor.broadcast.latency_ms stays empty
 *    for in-process runs (the interval issue #2289 asks for);
 *  - error logs lose their workflow/org attribution.
 *
 * The engine (executor.workflow.ts) enters the per-run context via
 * enterWorkflowErrorContext() at run start, so importing this module is the
 * only step needed to make the context resolvable in these processes.
 *
 * Side-effect import only: importing this file IS the registration.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { setWorkflowErrorContextStorage } from "@/lib/workflow/executor/error-context";

setWorkflowErrorContextStorage(new AsyncLocalStorage());
