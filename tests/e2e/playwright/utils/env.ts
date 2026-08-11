export function isRemoteMode(): boolean {
  return !!(process.env.BASE_URL && process.env.TEST_API_KEY);
}
