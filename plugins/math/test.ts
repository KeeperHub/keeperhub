export function testMath(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // System plugin - no credentials to test
  return Promise.resolve({ success: true });
}
