export function isPythPriceTriggerEnabled(): boolean {
  return Boolean(process.env.PYTH_API_KEY?.trim());
}

export function hasPythPriceTrigger(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) {
    return false;
  }
  return nodes.some((node) => {
    if (typeof node !== "object" || node === null || !("data" in node)) {
      return false;
    }
    const data = (node as { data?: unknown }).data;
    if (typeof data !== "object" || data === null || !("config" in data)) {
      return false;
    }
    const config = (data as { config?: unknown }).config;
    return (
      typeof config === "object" &&
      config !== null &&
      "triggerType" in config &&
      config.triggerType === "Pyth Price"
    );
  });
}
