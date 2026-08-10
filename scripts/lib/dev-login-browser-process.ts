import type { ChildProcess } from "node:child_process";

export type BrowserLaunchMessage =
  | { type: "browser-error"; message: string }
  | { type: "browser-ready" };

function isBrowserLaunchMessage(value: unknown): value is BrowserLaunchMessage {
  if (!(value && typeof value === "object" && "type" in value)) {
    return false;
  }
  const type = value.type;
  return type === "browser-ready" || type === "browser-error";
}

export function browserLaunchHelp(message: string): Error {
  return new Error(
    `dev-login: Chromium failed to start: ${message}\n` +
      "Run `pnpm exec playwright install chromium`, then retry " +
      "`pnpm dev:login`."
  );
}

export function waitForBrowserReady(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let timeout: NodeJS.Timeout;

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    const finish = (callback: () => void): void => {
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      child.removeAllListeners("message");
      callback();
    };

    timeout = setTimeout(() => {
      finish(() =>
        reject(
          browserLaunchHelp(`startup timed out after ${timeoutMs / 1000} seconds`)
        )
      );
    }, timeoutMs);

    child.once("error", (error) => {
      finish(() => reject(browserLaunchHelp(error.message)));
    });
    child.once("exit", (code) => {
      const detail = stderr.trim() || `browser process exited with status ${code}`;
      finish(() => reject(browserLaunchHelp(detail)));
    });
    child.on("message", (message: unknown) => {
      if (!isBrowserLaunchMessage(message)) {
        return;
      }
      if (message.type === "browser-error") {
        finish(() => reject(browserLaunchHelp(message.message)));
        return;
      }
      finish(() => {
        child.stderr?.destroy();
        child.unref();
        resolve();
      });
    });
  });
}
