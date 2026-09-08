import { describe, expect, it, vi } from "vitest";

/**
 * A failing protocol import used to still leave `plugins/index.ts` rewritten
 * -- main() wrote it before registerProtocolPlugins() ran, so the throw
 * fired with that file already regenerated and the rest of the tree
 * (protocols/index.ts, lib/types/integration.ts) untouched. The run exited 1
 * with the tree half done. main() now loads and registers protocols before
 * any generated file is written, so this asserts writeFileSync is never
 * called at all when the load fails -- not just that the two files this
 * PR's error message names are left alone.
 *
 * writeFileSync is mocked to a no-op so a regression (the old write-before-
 * load order) cannot actually touch the tracked tree while this runs;
 * existsSync/readdirSync/statSync are left real so discoverPlugins() can
 * read the actual plugins/ directory as it does in production.
 */

const { mockWriteFileSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

const { main, ProtocolDiscoveryError } = await import(
  "../../scripts/discover-plugins"
);

describe("main", () => {
  it("writes nothing when a protocol file fails to load", async () => {
    await expect(
      main({
        discover: () => ["/fake/protocols/broken.ts"],
        importProtocol: () => Promise.reject(new Error("boom")),
      })
    ).rejects.toBeInstanceOf(ProtocolDiscoveryError);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
