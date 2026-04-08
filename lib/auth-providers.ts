type AuthProvider = "email" | "github" | "google" | "vercel";

type EnabledProviders = {
  email: boolean;
  github: boolean;
  google: boolean;
  vercel: boolean;
};

interface WindowWithEnv extends Window {
  ENV?: {
    NEXT_PUBLIC_AUTH_PROVIDERS?: string;
    NEXT_PUBLIC_GITHUB_CLIENT_ID?: string;
    NEXT_PUBLIC_GOOGLE_CLIENT_ID?: string;
    NEXT_PUBLIC_VERCEL_CLIENT_ID?: string;
  };
}

/**
 * Get the list of enabled authentication providers from environment variables
 * Defaults to email only if not specified
 */
export function getEnabledAuthProviders(): EnabledProviders {
  const providersEnv =
    process.env.NEXT_PUBLIC_AUTH_PROVIDERS ||
    (typeof window === "undefined"
      ? undefined
      : (window as WindowWithEnv).ENV?.NEXT_PUBLIC_AUTH_PROVIDERS) ||
    "email";

  const enabledProviders = providersEnv
    .split(",")
    .map((p: string) => p.trim().toLowerCase());

  return {
    email: enabledProviders.includes("email"),
    github:
      enabledProviders.includes("github") &&
      !!(
        process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ||
        (typeof window !== "undefined" &&
          (window as WindowWithEnv).ENV?.NEXT_PUBLIC_GITHUB_CLIENT_ID)
      ),
    google:
      enabledProviders.includes("google") &&
      !!(
        process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
        (typeof window !== "undefined" &&
          (window as WindowWithEnv).ENV?.NEXT_PUBLIC_GOOGLE_CLIENT_ID)
      ),
    vercel:
      enabledProviders.includes("vercel") &&
      !!(
        process.env.NEXT_PUBLIC_VERCEL_CLIENT_ID ||
        (typeof window !== "undefined" &&
          (window as WindowWithEnv).ENV?.NEXT_PUBLIC_VERCEL_CLIENT_ID)
      ),
  };
}

/**
 * Get array of enabled provider names
 */
export function getEnabledProvidersList(): AuthProvider[] {
  const providers = getEnabledAuthProviders();
  return Object.entries(providers)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name as AuthProvider);
}

/**
 * Get the single enabled provider, or null if there are multiple
 */
export function getSingleProvider(): AuthProvider | null {
  const providersList = getEnabledProvidersList();
  return providersList.length === 1 ? providersList[0] : null;
}
