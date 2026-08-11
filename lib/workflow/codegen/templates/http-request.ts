/**
 * Code template for HTTP Request action step
 * This is a string template used for code generation - keep as string export
 */
export default `export async function httpRequestStep(input: {
  endpoint: string;
  httpMethod: string;
  httpHeaders?: string;
  httpBody?: string;
}) {
  "use step";
  
  let headers = {};
  if (input.httpHeaders) {
    try {
      headers = JSON.parse(input.httpHeaders);
    } catch {
      // If parsing fails, use empty headers
    }
  }
  
  let body: string | undefined;
  if (input.httpMethod !== "GET" && input.httpBody) {
    try {
      const parsedBody = JSON.parse(input.httpBody);
      if (Object.keys(parsedBody).length > 0) {
        body = JSON.stringify(parsedBody);
      }
    } catch {
      if (input.httpBody.trim() && input.httpBody.trim() !== "{}") {
        body = input.httpBody;
      }
    }
  }
  
  const response = await fetch(input.endpoint, {
    method: input.httpMethod,
    headers,
    body,
  });
  
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}`;
