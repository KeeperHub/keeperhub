import { generateHubOGImage } from "@/app/api/og/generate-og";

export async function GET(): Promise<Response> {
  return await generateHubOGImage();
}
