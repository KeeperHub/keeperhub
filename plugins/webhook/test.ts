export function testWebhook(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  return Promise.resolve({ success: true });
}
