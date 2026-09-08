import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TEST_API_KEY = __ENV.TEST_API_KEY || "";
const CF_ACCESS_CLIENT_ID = __ENV.CF_ACCESS_CLIENT_ID || "";
const CF_ACCESS_CLIENT_SECRET = __ENV.CF_ACCESS_CLIENT_SECRET || "";
const LOAD_TEST_BYPASS_TOKEN = __ENV.LOAD_TEST_BYPASS_TOKEN || "";

export function getBaseUrl() {
  return BASE_URL;
}

export function getCommonHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
  };

  if (TEST_API_KEY) {
    headers["X-Test-API-Key"] = TEST_API_KEY;
  }

  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
  }

  if (LOAD_TEST_BYPASS_TOKEN) {
    headers["X-Load-Test-Mfa-Bypass"] = LOAD_TEST_BYPASS_TOKEN;
  }

  return headers;
}

export function getAdminHeaders() {
  const headers = getCommonHeaders();
  if (TEST_API_KEY) {
    headers["Authorization"] = `Bearer ${TEST_API_KEY}`;
  }
  return headers;
}

export function post(path, body, params = {}) {
  const url = `${BASE_URL}${path}`;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const mergedParams = {
    ...params,
    headers: { ...getCommonHeaders(), ...(params.headers || {}) },
  };
  return http.post(url, payload, mergedParams);
}

export function get(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  const mergedParams = {
    ...params,
    headers: { ...getCommonHeaders(), ...(params.headers || {}) },
  };
  return http.get(url, mergedParams);
}

export function put(path, body, params = {}) {
  const url = `${BASE_URL}${path}`;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const mergedParams = {
    ...params,
    headers: { ...getCommonHeaders(), ...(params.headers || {}) },
  };
  return http.put(url, payload, mergedParams);
}

export function adminGet(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  const mergedParams = {
    ...params,
    headers: { ...getAdminHeaders(), ...(params.headers || {}) },
  };
  return http.get(url, mergedParams);
}

export function adminPost(path, body, params = {}) {
  const url = `${BASE_URL}${path}`;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const mergedParams = {
    ...params,
    headers: { ...getAdminHeaders(), ...(params.headers || {}) },
  };
  return http.post(url, payload, mergedParams);
}
