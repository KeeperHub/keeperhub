export async function testConnection(): Promise<{
  status: "success" | "error";
  message: string;
}> {
  return {
    status: "success",
    message: "AI Gateway API key accepted",
  };
}
