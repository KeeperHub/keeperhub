import { type AddressInfo, type Server, createServer } from "node:http";

export interface MockApiServer {
  url: string;
  setResponse(path: string, body: unknown): void;
  close(): Promise<void>;
}

export async function startMockApi(): Promise<MockApiServer> {
  const responses = new Map<string, unknown>();

  const server: Server = createServer((req, res) => {
    const fullUrl = req.url ?? "/";
    const pathOnly = fullUrl.split("?")[0];
    const body = responses.get(pathOnly);
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path: pathOnly }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    setResponse(path, body) {
      responses.set(path, body);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
