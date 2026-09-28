import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  loadProtocolDefinitions,
  ProtocolDiscoveryError,
  type ProtocolLoadDeps,
} from "../../scripts/discover-plugins";

/**
 * `protocols/index.ts` and `lib/types/integration.ts` are tracked files, so a
 * generator that writes a registry missing a protocol produces a deletion that
 * reads as a normal regeneration under a "DO NOT EDIT MANUALLY" header. These
 * tests pin the loader to failing closed: the caller gets nothing to write.
 */

const AAVE = "/repo/protocols/aave-v3.ts";
const LIDO = "/repo/protocols/lido.ts";
const SAFE = "/repo/protocols/safe.ts";

function definition(slug: string) {
  return { default: { slug, name: slug.toUpperCase() } };
}

/** The error, or a failure saying it never threw - never a union to narrow. */
async function failureFrom(
  deps: ProtocolLoadDeps
): Promise<ProtocolDiscoveryError> {
  try {
    await loadProtocolDefinitions(deps);
  } catch (error) {
    if (error instanceof ProtocolDiscoveryError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadProtocolDefinitions to throw, it resolved");
}

describe("loadProtocolDefinitions", () => {
  it("throws when a protocol file cannot be imported", async () => {
    await expect(
      loadProtocolDefinitions({
        discover: () => [AAVE, LIDO],
        importProtocol: (path) =>
          path === AAVE
            ? Promise.reject(new Error("Cannot find module './missing'"))
            : Promise.resolve(definition("lido")),
      })
    ).rejects.toBeInstanceOf(ProtocolDiscoveryError);
  });

  it("names every failure, not only the first", async () => {
    const failing = new Set([AAVE, SAFE]);

    const error = await failureFrom({
      discover: () => [AAVE, LIDO, SAFE],
      importProtocol: (path) =>
        failing.has(path)
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(definition("lido")),
    });

    expect(error.failures.map((f) => f.filePath)).toEqual([AAVE, SAFE]);
    expect(error.message).toContain(AAVE);
    expect(error.message).toContain(SAFE);
  });

  it("treats a default export without a slug as a failure, not a skip", async () => {
    const error = await failureFrom({
      discover: () => [AAVE],
      importProtocol: () => Promise.resolve({ default: { name: "no slug" } }),
    });

    expect(error.failures[0]?.reason).toContain("slug");
  });

  it("names the tracked files it left alone, so the operator knows what to trust", async () => {
    const error = await failureFrom({
      discover: () => [AAVE],
      importProtocol: () => Promise.reject(new Error("boom")),
    });

    expect(error.message).toContain("protocols/index.ts");
    expect(error.message).toContain("lib/types/integration.ts");
  });

  it("returns every entry when all files load", async () => {
    const entries = await loadProtocolDefinitions({
      discover: () => [AAVE, LIDO],
      importProtocol: (path) =>
        Promise.resolve(definition(path === AAVE ? "aave-v3" : "lido")),
    });

    expect(entries.map((e) => e.slug)).toEqual(["aave-v3", "lido"]);
    expect(entries.map((e) => e.fileStem)).toEqual(["aave-v3", "lido"]);
  });

  it("still returns nothing when the directory holds no protocol files", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      loadProtocolDefinitions({ discover: () => [] })
    ).resolves.toEqual([]);

    log.mockRestore();
  });

  it("collects an import failure and a missing-slug failure through the same path", async () => {
    // A rejected import and a resolved-but-slugless module used to be two
    // different failure mechanisms (a catch, and a push+continue beside it).
    // Both now become a rejection inside the same Promise.allSettled map, so
    // this asserts they land in one failures array together, in file order.
    const error = await failureFrom({
      discover: () => [AAVE, LIDO, SAFE],
      importProtocol: (path) => {
        if (path === AAVE) {
          return Promise.reject(new Error("boom"));
        }
        if (path === LIDO) {
          return Promise.resolve({ default: { name: "no slug" } });
        }
        return Promise.resolve(definition("safe"));
      },
    });

    expect(error.failures.map((f) => f.filePath)).toEqual([AAVE, LIDO]);
    expect(error.failures[0]?.reason).toBe("boom");
    expect(error.failures[1]?.reason).toContain("slug");
  });

  it("imports a real file by absolute path with no importProtocol override", async () => {
    // Exercises the default importProtocol end-to-end against a real file,
    // rather than a stand-in. This is NOT a regression test for
    // ERR_UNSUPPORTED_ESM_URL_SCHEME: Vitest's module runner resolves a
    // project-relative specifier itself and does not go through Node's
    // native ESM loader the way `tsx scripts/discover-plugins.ts` does, so a
    // bare path here does not reproduce the Windows failure and this test
    // does not flip if pathToFileURL is removed. That fix was verified with
    // a raw `tsx` run importing this same fixture by a bare Windows path:
    // ERR_UNSUPPORTED_ESM_URL_SCHEME without pathToFileURL, success with it.
    const fixture = fileURLToPath(
      new URL("./fixtures/protocol-fixture.ts", import.meta.url)
    );

    const entries = await loadProtocolDefinitions({
      discover: () => [fixture],
    });

    expect(entries).toEqual([
      {
        slug: "protocol-fixture",
        fileStem: "protocol-fixture",
        definition: expect.objectContaining({ slug: "protocol-fixture" }),
      },
    ]);
  });
});
