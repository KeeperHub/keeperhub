import { check } from "k6";
import { post } from "./http.js";

const PASSWORD = __ENV.LOAD_TEST_USER_PASSWORD || "K6LoadTest!2024";

export function registerAndLogin(vuId) {
  const email = `k6-loadtest-vu${vuId}@techops.services`;

  const signInRes = post("/api/auth/sign-in/email", { email, password: PASSWORD });
  const signInOk = check(signInRes, {
    "signin: status 200": (r) => r.status === 200,
  });
  if (!signInOk) {
    console.error(
      `Sign-in failed for ${email}: ${signInRes.status} ${signInRes.body}`
    );
    return null;
  }

  let apiKey = null;
  const apiKeyRes = post("/api/api-keys", { name: `k6-test-vu${vuId}` });
  if (apiKeyRes.status === 200) {
    apiKey = JSON.parse(apiKeyRes.body).key;
  }

  return { email, password: PASSWORD, apiKey };
}
