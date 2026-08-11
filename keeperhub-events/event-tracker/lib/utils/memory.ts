import { logger } from "./logger";

export function logMemoryUsage(): void {
  const memoryUsage = process.memoryUsage();
  logger.log(
    `Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
  );
}
