export async function testTelegram(credentials: Record<string, string>) {
  try {
    const botToken = credentials.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      return { success: false, error: "Bot token is required" };
    }

    // Validate bot token by calling getMe endpoint
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
      {
        method: "GET",
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: "Invalid bot token" };
      }
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error:
          (errorData as { description?: string })?.description ||
          `API error: HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: { username?: string };
    };

    if (!data.ok) {
      return { success: false, error: "Bot token validation failed" };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
