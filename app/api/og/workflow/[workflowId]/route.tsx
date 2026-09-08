import { generateWorkflowOGImage } from "@/app/api/og/generate-og";

export async function GET(
  _request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<Response> {
  const { workflowId } = await context.params;
  return generateWorkflowOGImage(workflowId);
}
