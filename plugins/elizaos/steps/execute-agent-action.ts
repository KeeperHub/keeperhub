import type { ElizaOSCredentials } from "../credentials";

export interface ExecuteAgentActionConfig {
  agentId: string;
  action: string;
  payload: string;
}

export async function executeAgentActionStep(
  config: ExecuteAgentActionConfig,
  credentials: ElizaOSCredentials
) {
  const endpoint = credentials.endpointUrl || "http://localhost:3000";
  const agentId = config.agentId || credentials.agentId || "default";

  try {
    const res = await fetch(`${endpoint}/api/agents/${agentId}/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      },
      body: JSON.stringify({
        action: config.action,
        payload: config.payload ? JSON.parse(config.payload) : {},
      }),
    });

    const data = await res.json();
    return {
      success: res.ok,
      response: JSON.stringify(data),
      error: res.ok ? undefined : (data as any)?.error || "Agent execution failed",
    };
  } catch (err: any) {
    return {
      success: false,
      response: "",
      error: err.message,
    };
  }
}
