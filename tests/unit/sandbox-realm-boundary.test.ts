import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op mock
  logUserError: () => {},
}));

import { type RunCodeInput, runCodeStep } from "@/plugins/code/steps/run-code";

type RunResult =
  | { success: true; result: unknown; logs: unknown[] }
  | { success: false; error: string; logs: unknown[] };

const ESCAPED_FLAG_REGEX = /"escaped":true/;
const ESCAPED_MARKER_REGEX = /ESCAPED/;

async function run(code: string): Promise<RunResult> {
  return (await runCodeStep({ code, timeout: 5 } as RunCodeInput)) as RunResult;
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v
  );
}

// Every payload reports through its own return value (or a thrown message)
// whether it reached the host realm, so nothing here performs any I/O.
function expectContained(outcome: RunResult): void {
  const text = serialized(outcome);
  expect(text).not.toMatch(ESCAPED_FLAG_REGEX);
  expect(text).not.toMatch(ESCAPED_MARKER_REGEX);
}

function thenOverride(reach: string): string {
  return `
    const realThen = Promise.prototype.then;
    let armed = false;
    Promise.prototype.then = function (onF, onR) {
      if (armed || typeof onF !== "function") return realThen.call(this, onF, onR);
      armed = true;
      try {
        const proc = ${reach};
        return realThen.call(this, function () { return onF({ escaped: true, pid: proc.pid, hasFs: !!proc.getBuiltinModule }); });
      } catch (e) {
        return realThen.call(this, function () { return onF({ escaped: false, err: String(e).slice(0, 300) }); });
      }
    };
    return "armed";
  `;
}

// A Proxy whose apply trap probes the realm of the argument list it receives.
// A host built-in calling it hands over a host-realm array.
const PROXY_PROBE = `
  const status = { escaped: false, pid: null };
  const probe = new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      try {
        const proc = args.constructor.constructor("return process")();
        status.escaped = true;
        status.pid = proc.pid;
      } catch (_e) {}
      return status.escaped ? "ESCAPED" : "probe";
    },
  });
`;

describe("sandbox host never invokes realm-overridable promise methods", () => {
  it("contains the Promise.prototype.then override (onFulfilled.constructor)", async () => {
    const outcome = await run(
      thenOverride('onF.constructor("return process")()')
    );
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: true, result: "armed" });
  }, 15_000);

  it("contains the Promise.prototype.then override (onRejected.constructor)", async () => {
    const outcome = await run(
      thenOverride('onR.constructor("return process")()')
    );
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: true, result: "armed" });
  }, 15_000);

  it("contains the Promise.prototype.then override (prototype of the callback)", async () => {
    const outcome = await run(
      thenOverride('Object.getPrototypeOf(onF).constructor("return process")()')
    );
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: true, result: "armed" });
  }, 15_000);

  it("contains the Promise.prototype.then override (AsyncFunction via the callback)", async () => {
    const outcome = await run(`
      const realThen = Promise.prototype.then;
      let armed = false;
      Promise.prototype.then = function (onF, onR) {
        if (armed || typeof onF !== "function") return realThen.call(this, onF, onR);
        armed = true;
        try {
          const AsyncFn = onF.constructor("return (async function () {}).constructor")();
          const pending = AsyncFn("return process")();
          return realThen.call(this, function () {
            return realThen.call(pending, function (proc) {
              return onF({ escaped: true, pid: proc.pid });
            });
          });
        } catch (e) {
          return realThen.call(this, function () { return onF({ escaped: false, err: String(e) }); });
        }
      };
      return "armed";
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: true, result: "armed" });
  }, 15_000);

  it("contains a Promise.prototype.finally override", async () => {
    const outcome = await run(`
      const out = { escaped: false, pid: null };
      const realFinally = Promise.prototype.finally;
      Promise.prototype.finally = function (f) {
        try {
          const proc = f.constructor("return process")();
          out.escaped = true;
          out.pid = proc.pid;
        } catch (_e) {}
        return realFinally.call(this, f);
      };
      return out;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a Promise.prototype.catch override", async () => {
    const outcome = await run(`
      const out = { escaped: false, pid: null };
      const realCatch = Promise.prototype.catch;
      Promise.prototype.catch = function (f) {
        try {
          const proc = f.constructor("return process")();
          out.escaped = true;
          out.pid = proc.pid;
        } catch (_e) {}
        return realCatch.call(this, f);
      };
      throw new Error("rejected on purpose");
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: false });
    if (!outcome.success) {
      expect(outcome.error).toContain("rejected on purpose");
    }
  }, 15_000);

  it("contains a Promise subclass installed through Symbol.species and a replaced Promise global", async () => {
    const outcome = await run(`
      const out = { escaped: false, pid: null };
      class Evil extends Promise {
        then(onF, onR) {
          if (typeof onF === "function") {
            try {
              const proc = onF.constructor("return process")();
              out.escaped = true;
              out.pid = proc.pid;
            } catch (_e) {}
          }
          return super.then(onF, onR);
        }
      }
      Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { return Evil; } });
      globalThis.Promise = Evil;
      return out;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a thenable returned from inside the user function", async () => {
    const outcome = await run(`
      return {
        then(res) {
          try {
            const proc = res.constructor("return process")();
            res({ escaped: true, pid: proc.pid });
          } catch (e) {
            res({ escaped: false, err: String(e) });
          }
        },
      };
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a thenable that breaks out of the function wrapper as the script completion value", async () => {
    const outcome = await run(`
      return 1;
      })();
      const thenable = {
        then(onF, onR) {
          try {
            const proc = onF.constructor("return process")();
            return Promise.resolve(onF({ escaped: true, pid: proc.pid }));
          } catch (e) {
            return Promise.resolve(onF({ escaped: false, err: String(e) }));
          }
        },
      };
      true ? thenable : (async () => {
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a value thrown synchronously past the function wrapper", async () => {
    const outcome = await run(`
      return 1;
      })();
      ${PROXY_PROBE}
      throw { message: { [Symbol.toPrimitive]: probe } };
      (async () => {
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: false });
  }, 15_000);
});

describe("sandbox host never calls user hooks while encoding results or errors", () => {
  it("contains a Proxy getter on the returned object", async () => {
    const outcome = await run(`
      ${PROXY_PROBE}
      const out = {};
      Object.defineProperty(out, "probe", { enumerable: true, get: probe });
      out.status = status;
      return out;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { probe: "probe", status: { escaped: false } },
    });
  }, 15_000);

  it("contains a logged toJSON that inspects its arguments and receiver", async () => {
    const outcome = await run(`
      const status = { escaped: false, pid: null };
      const logged = {
        toJSON() {
          for (const candidate of [arguments, this]) {
            try {
              const proc = candidate.constructor.constructor("return process")();
              status.escaped = true;
              status.pid = proc.pid;
            } catch (_e) {}
          }
          return "json";
        },
      };
      console.log(logged);
      return status;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
      logs: [{ level: "log", args: ["json"] }],
    });
  }, 15_000);

  it("contains a Proxy toPrimitive on a rejected error's message", async () => {
    const outcome = await run(`
      ${PROXY_PROBE}
      const viaProxy = { [Symbol.toPrimitive]: probe };
      throw { message: viaProxy, stack: viaProxy };
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({ success: false });
  }, 15_000);
});

describe("sandbox bridge accepts primitives only", () => {
  it("contains a Proxy toJSON passed to console.log", async () => {
    const outcome = await run(`
      ${PROXY_PROBE}
      console.log({ toJSON: probe });
      return status;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a replaced JSON.stringify feeding the fetch bridge", async () => {
    const outcome = await run(`
      ${PROXY_PROBE}
      const viaProxy = { [Symbol.toPrimitive]: probe };
      JSON.stringify = function () { return viaProxy; };
      try { await fetch("ftp://invalid.invalid/"); } catch (_e) {}
      return status;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("contains a replaced String global feeding the URL bridge", async () => {
    const outcome = await run(`
      ${PROXY_PROBE}
      const viaProxy = { [Symbol.toPrimitive]: probe };
      const realString = String;
      globalThis.String = function () { return viaProxy; };
      try { new URL("https://example.com/"); } catch (_e) {}
      globalThis.String = realString;
      return status;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);

  it("hands Error.prepareStackTrace only realm call sites", async () => {
    const outcome = await run(`
      const out = { escaped: false };
      Error.prepareStackTrace = function (_err, sites) {
        try {
          const proc = sites.constructor.constructor("return process")();
          out.escaped = true;
          out.pid = proc.pid;
        } catch (_e) {}
        return "trace";
      };
      new Error("x").stack;
      return out;
    `);
    expectContained(outcome);
    expect(outcome).toMatchObject({
      success: true,
      result: { escaped: false },
    });
  }, 15_000);
});

describe("sandbox results keep their shape across the realm boundary", () => {
  it("returns structured values, logs and errors unchanged", async () => {
    const ok = await run(`
      console.log("hello", { a: 1, "$": "bigint" }, 10n, undefined);
      return { n: 1n, d: new Date(0), m: new Map([["k", new Set([1])]]), b: new Uint16Array([1, 2]), dv: new DataView(new ArrayBuffer(2)), re: /x/g };
    `);
    expect(ok.success).toBe(true);
    if (ok.success) {
      const r = ok.result as Record<string, unknown>;
      expect(r.n).toBe(BigInt(1));
      expect(r.d).toEqual(new Date(0));
      expect(r.m).toEqual(new Map([["k", new Set([1])]]));
      expect(r.b).toEqual(new Uint16Array([1, 2]));
      expect(r.dv).toBeInstanceOf(DataView);
      expect(r.re).toEqual(/x/g);
      expect(ok.logs).toEqual([
        {
          level: "log",
          args: ["hello", { a: 1, $: "bigint" }, "10", "undefined"],
        },
      ]);
    }
    const failed = await run("const x = 1;\nthrow new RangeError('nope');");
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error).toBe("Code execution failed: nope");
    }
  }, 15_000);
});
