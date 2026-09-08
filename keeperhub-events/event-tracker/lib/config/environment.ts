export const KEEPERHUB_API_URL: string = process.env.KEEPERHUB_API_URL || "";
export const REDIS_HOST: string = process.env.REDIS_HOST || "localhost";
export const REDIS_PORT: number = Number(process.env.REDIS_PORT) || 6379;
export const REDIS_PASSWORD: string = process.env.REDIS_PASSWORD || "";
export const JWT_TOKEN_USERNAME: string = process.env.JWT_TOKEN_USERNAME || "";
export const JWT_TOKEN_PASSWORD: string = process.env.JWT_TOKEN_PASSWORD || "";
export const ETHERSCAN_API_KEY: string = process.env.ETHERSCAN_API_KEY || "";
export const NODE_ENV: string = process.env.NODE_ENV || "development";

export const SQS_QUEUE_URL: string = process.env.SQS_QUEUE_URL || "";
export const AWS_REGION: string = process.env.AWS_REGION || "us-east-1";
export const AWS_ENDPOINT_URL: string | undefined =
  process.env.AWS_ENDPOINT_URL;
