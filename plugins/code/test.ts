import { createContext, runInContext } from "node:vm";

export function testCode(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = createContext({});
    const result: unknown = runInContext("1 + 1", ctx, { timeout: 5000 });
    if (result !== 2) {
      return Promise.resolve({
        success: false,
        error: `VM sanity check returned unexpected result: ${String(result)}`,
      });
    }
    return Promise.resolve({ success: true });
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: `VM sanity check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
