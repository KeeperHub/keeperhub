"use client";

import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { setConnectPanelActive } from "@/components/auth/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  type AuthErrorBody,
  authErrorCode,
  authErrorMessage,
} from "@/lib/auth/auth-error-envelope-client";
import { authClient, signIn, signUp } from "@/lib/auth-client";
import { DISPOSABLE_EMAIL_REJECTION_MESSAGE } from "@/lib/auth-disposable-emails-message";
import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";
import { getEnabledAuthProviders } from "@/lib/auth-providers";

type View =
  | "main"
  | "signup"
  | "forgot"
  | "reset"
  | "verify"
  | "mfa-email"
  | "mfa-totp";

type Item = { key: string; node: React.ReactNode };

const EXISTING_ACCOUNT = /already|exists|duplicate/i;

const GitHubIcon = (): React.ReactElement => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="currentColor"
    role="img"
    viewBox="0 0 24 24"
  >
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const GoogleIcon = (): React.ReactElement => (
  <Image alt="" className="size-4" height={16} src="/google.svg" width={16} />
);

// Auth / gate surfaces we must never redirect back into after a sign-in:
// bouncing to one of these would immediately re-prompt and loop.
const UNSAFE_REDIRECT_PREFIXES = [
  "/welcome",
  "/enroll-mfa",
  "/verify-mfa",
  "/enforce-mfa",
  "/verify-ip",
];

const REDIRECT_QUERY_HASH_REGEX = /[?#]/;

// Only honor a redirect target that is a same-origin in-app path and not an
// auth/gate surface; anything else (off-site, protocol-relative, or an auth
// page) falls back to "/" to avoid open redirects and sign-in loops.
function safePostAuthTarget(target: string | undefined): string {
  if (!target?.startsWith("/") || target.startsWith("//")) {
    return "/";
  }
  const path = target.split(REDIRECT_QUERY_HASH_REGEX)[0];
  if (
    UNSAFE_REDIRECT_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`)
    )
  ) {
    return "/";
  }
  return target;
}

function reloadHome(target = "/"): void {
  window.dispatchEvent(new CustomEvent(AUTH_SUCCESS_EVENT));
  window.location.assign(target);
}

/**
 * Inline email + social auth for the Connect modal's right panel. All steps —
 * credential entry, sign-up, email verification, MFA email OTP, and TOTP — are
 * handled as views in the same animated panel so the user never leaves the modal.
 */
export function ConnectAuthPanel({
  hideChooserHeader = false,
  onWalletClick,
  redirectTo,
}: {
  // When the surrounding surface already carries a title (e.g. the welcome
  // page), suppress the default view's own header to avoid repeating the same
  // phrase. Contextual step headers (verify, MFA) stay.
  hideChooserHeader?: boolean;
  // When provided, a "Wallet" button is shown in the social row; clicking it
  // hands off to the surrounding surface to reveal the wallet picker.
  onWalletClick?: () => void;
  // Where to land after a successful sign-in. Defaults to "/"; the shared
  // AuthDialog passes the caller's intent (e.g. back to an accept-invite page).
  redirectTo?: string;
} = {}): React.ReactElement {
  const postAuthTarget = safePostAuthTarget(redirectTo);
  const providers = getEnabledAuthProviders();
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  const [view, setView] = useState<View>("main");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [mfaEmailOtp, setMfaEmailOtp] = useState("");
  const [mfaTotpCode, setMfaTotpCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [social, setSocial] = useState<"github" | "google" | null>(null);
  const [captchaToken, setCaptchaToken] = useState("");
  const captchaRef = useRef<TurnstileInstance | null>(null);

  const inCodeStep =
    view === "verify" || view === "mfa-email" || view === "mfa-totp";

  useEffect(() => {
    setConnectPanelActive(loading || inCodeStep);
    return () => setConnectPanelActive(false);
  }, [loading, inCodeStep]);

  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    setHeight(el.scrollHeight);
    return () => observer.disconnect();
  }, []);

  const handleSocial = async (provider: "github" | "google"): Promise<void> => {
    setSocial(provider);
    try {
      // Always land on "/" so the onboarding gate runs: social can be a new
      // signup, and the gate only fires on "/", so a redirectTo here would let
      // a first-time social user skip onboarding.
      await signIn.social({ provider, callbackURL: "/" });
    } catch {
      setSocial(null);
      toast.error(`Could not start ${provider} sign-in.`);
    }
  };

  const handleSignIn = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/strict-signin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as AuthErrorBody & {
        signedIn?: boolean;
      };
      if (!response.ok) {
        setError(authErrorMessage(body, "Sign in failed"));
        return;
      }
      if (body.signedIn) {
        toast.success("Signed in successfully!");
        reloadHome(postAuthTarget);
        return;
      }
      setMfaEmailOtp("");
      setView("mfa-email");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signUp.email({
        email,
        password,
        name: email.split("@")[0],
        ...(captchaToken && {
          fetchOptions: { headers: { "x-captcha-response": captchaToken } },
        }),
      });
      if (result.error) {
        const msg = result.error.message || "Sign up failed";
        if (msg === DISPOSABLE_EMAIL_REJECTION_MESSAGE) {
          setError(DISPOSABLE_EMAIL_REJECTION_MESSAGE);
        } else if (EXISTING_ACCOUNT.test(msg)) {
          await authClient.emailOtp.sendVerificationOtp({
            email,
            type: "email-verification",
          });
          setOtp("");
          setView("verify");
          toast.info("This email already exists. Verify it to continue.");
        } else {
          setError(msg);
        }
        captchaRef.current?.reset();
        setCaptchaToken("");
        return;
      }
      setOtp("");
      setView("verify");
      toast.success(`Verification code sent to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
      captchaRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const verifyResult = await authClient.emailOtp.verifyEmail({
        email,
        otp,
      });
      if (verifyResult.error) {
        setError(verifyResult.error.message ?? "Verification failed");
        return;
      }
      const finish = await fetch("/api/auth/finish-credential-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const finishBody = (await finish.json().catch(() => ({}))) as {
        error?: string;
        redirect?: string;
      };
      if (!finish.ok) {
        setError(finishBody.error ?? "Could not finish signup");
        return;
      }
      toast.success("Email verified! Set up your authenticator to continue.");
      window.dispatchEvent(new CustomEvent(AUTH_SUCCESS_EVENT));
      window.location.assign(finishBody.redirect ?? "/enroll-mfa");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async (): Promise<void> => {
    setError("");
    setLoading(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      });
      if (res.error) {
        setError(res.error.message ?? "Failed to resend code");
        return;
      }
      toast.success("New code sent");
      setOtp("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend code");
    } finally {
      setLoading(false);
    }
  };

  const handleMfaResend = async (): Promise<void> => {
    const res = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    if (res.error) {
      toast.error(res.error.message ?? "Could not resend code");
      return;
    }
    toast.success("Code resent");
  };

  const handleMfaEmailContinue = (e: React.FormEvent): void => {
    e.preventDefault();
    if (mfaEmailOtp.trim().length !== 6) {
      setError("Enter the 6-digit email code");
      return;
    }
    setError("");
    setMfaTotpCode("");
    setView("mfa-totp");
  };

  const handleMfaComplete = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (mfaTotpCode.trim().length !== 6) {
      setError("Enter the 6-digit authenticator code");
      return;
    }
    if (mfaEmailOtp.trim().length !== 6) {
      setError("Missing email code. Start sign-in again.");
      setView("main");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/strict-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          emailOtp: mfaEmailOtp.trim(),
          totpCode: mfaTotpCode.trim(),
        }),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as AuthErrorBody & {
        redirect?: string;
      };
      if (!response.ok) {
        const code = authErrorCode(body);
        if (code === "invalid_email_otp") {
          setError(authErrorMessage(body, "Invalid email code"));
          setMfaEmailOtp("");
          setView("mfa-email");
          return;
        }
        if (code === "invalid_totp") {
          setError(authErrorMessage(body, "Invalid authenticator code"));
          setMfaTotpCode("");
          return;
        }
        setError(authErrorMessage(body, "Sign in failed"));
        return;
      }
      if (body.redirect === "/verify-ip") {
        window.location.assign("/verify-ip");
        return;
      }
      toast.success("Signed in successfully!");
      reloadHome(postAuthTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotRequest = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? "Failed to send reset code");
        return;
      }
      toast.success("Check your inbox for the reset code.");
      setOtp("");
      setView("reset");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send reset code"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          email,
          otp,
          newPassword,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? "Failed to reset password");
        return;
      }
      toast.success("Password reset! Please sign in.");
      setPassword("");
      setView("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  const titles: Record<View, string> = {
    main: "Log in or sign up",
    signup: "Create your account",
    forgot: "Reset your password",
    reset: "Enter your reset code",
    verify: "Verify your email",
    "mfa-email": "Check your email",
    "mfa-totp": "Authenticator code",
  };
  const descriptions: Record<View, string> = {
    main: "Use email, a social account, or your wallet to get started.",
    signup: "Sign up with your email and a password.",
    forgot: "We'll email you a code to reset your password.",
    reset: "Enter the code we emailed and choose a new password.",
    verify: `Enter the 6-digit code sent to ${email}.`,
    "mfa-email": `Enter the 6-digit code sent to ${email}. We'll ask for your authenticator next.`,
    "mfa-totp": "Enter the current 6-digit code from your authenticator app.",
  };

  const onSubmit = (e: React.FormEvent): void => {
    if (view === "main") {
      handleSignIn(e);
    } else if (view === "signup") {
      handleSignUp(e);
    } else if (view === "verify") {
      handleVerify(e);
    } else if (view === "forgot") {
      handleForgotRequest(e);
    } else if (view === "reset") {
      handleReset(e);
    } else if (view === "mfa-email") {
      handleMfaEmailContinue(e);
    } else if (view === "mfa-totp") {
      handleMfaComplete(e);
    } else {
      e.preventDefault();
    }
  };

  const items: Item[] = [];
  if (!(hideChooserHeader && view === "main")) {
    items.push({
      key: "header",
      node: (
        <div>
          <h2 className="font-semibold text-base">{titles[view]}</h2>
          <p className="text-muted-foreground text-sm">{descriptions[view]}</p>
        </div>
      ),
    });
  }

  const emailField = (autoComplete: string): React.ReactNode => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="auth-email">Email</Label>
      <Input
        autoComplete={autoComplete}
        id="auth-email"
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={email}
      />
    </div>
  );

  if (view === "main") {
    items.push({
      key: "socials",
      node: (
        <div className="flex gap-2">
          {providers.google ? (
            <Button
              className="min-w-0 flex-1 justify-center"
              disabled={social !== null}
              onClick={() => handleSocial("google")}
              type="button"
              variant="outline"
            >
              {social === "google" ? <Spinner /> : <GoogleIcon />}
              Google
            </Button>
          ) : null}
          {providers.github ? (
            <Button
              className="min-w-0 flex-1 justify-center"
              disabled={social !== null}
              onClick={() => handleSocial("github")}
              type="button"
              variant="outline"
            >
              {social === "github" ? <Spinner /> : <GitHubIcon />}
              GitHub
            </Button>
          ) : null}
          {onWalletClick ? (
            <Button
              className="min-w-0 flex-1 justify-center"
              disabled={social !== null}
              onClick={onWalletClick}
              type="button"
              variant="outline"
            >
              <Wallet className="size-4" />
              Wallet
            </Button>
          ) : null}
        </div>
      ),
    });
    items.push({
      key: "or",
      node: (
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-muted-foreground text-xs">OR</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ),
    });
    items.push({ key: "email", node: emailField("email") });
    items.push({
      key: "password",
      node: (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="auth-password">Password</Label>
            <button
              className="text-muted-foreground text-xs hover:text-foreground"
              onClick={() => {
                setError("");
                setView("forgot");
              }}
              type="button"
            >
              Forgot password?
            </button>
          </div>
          <Input
            autoComplete="current-password"
            id="auth-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            required
            type="password"
            value={password}
          />
        </div>
      ),
    });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Sign in"}
        </Button>
      ),
    });
    items.push({
      key: "signin-create",
      node: (
        <p className="text-center text-muted-foreground text-sm">
          New here?{" "}
          <button
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => {
              setError("");
              setView("signup");
            }}
            type="button"
          >
            Create an account
          </button>
        </p>
      ),
    });
  }

  if (view === "signup") {
    items.push({ key: "email", node: emailField("email") });
    items.push({
      key: "password",
      node: (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="auth-password">Password</Label>
          <Input
            autoComplete="new-password"
            id="auth-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a password"
            required
            type="password"
            value={password}
          />
        </div>
      ),
    });
    if (turnstileSiteKey) {
      items.push({
        key: "captcha",
        node: (
          <Turnstile
            onError={() => setCaptchaToken("")}
            onExpire={() => setCaptchaToken("")}
            onSuccess={setCaptchaToken}
            options={{ theme: "auto" }}
            ref={captchaRef}
            siteKey={turnstileSiteKey}
          />
        ),
      });
    }
    items.push({
      key: "submit",
      node: (
        <Button
          className="w-full"
          disabled={loading || (!!turnstileSiteKey && !captchaToken)}
          type="submit"
        >
          {loading ? <Spinner className="size-4" /> : "Create account"}
        </Button>
      ),
    });
    items.push({
      key: "signup-signin",
      node: (
        <p className="text-center text-muted-foreground text-sm">
          Already have an account?{" "}
          <button
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => {
              setError("");
              setView("main");
            }}
            type="button"
          >
            Sign in
          </button>
        </p>
      ),
    });
  }

  if (view === "verify") {
    items.push({
      key: "otp",
      node: (
        <Input
          autoFocus
          inputMode="numeric"
          maxLength={6}
          onChange={(e) => setOtp(e.target.value)}
          placeholder="123456"
          value={otp}
        />
      ),
    });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Verify"}
        </Button>
      ),
    });
    items.push({
      key: "verify-resend",
      node: (
        <p className="text-center text-muted-foreground text-sm">
          Didn't receive it?{" "}
          <button
            className="font-medium text-foreground underline underline-offset-2"
            disabled={loading}
            onClick={handleResendVerification}
            type="button"
          >
            Resend code
          </button>
        </p>
      ),
    });
  }

  if (view === "mfa-email") {
    items.push({
      key: "otp",
      node: (
        <Input
          autoFocus
          inputMode="numeric"
          maxLength={6}
          onChange={(e) => setMfaEmailOtp(e.target.value)}
          placeholder="123456"
          value={mfaEmailOtp}
        />
      ),
    });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Continue"}
        </Button>
      ),
    });
    items.push({
      key: "mfa-email-resend",
      node: (
        <p className="text-center text-muted-foreground text-sm">
          Didn't receive it?{" "}
          <button
            className="font-medium text-foreground underline underline-offset-2"
            disabled={loading}
            onClick={handleMfaResend}
            type="button"
          >
            Resend code
          </button>
        </p>
      ),
    });
  }

  if (view === "mfa-totp") {
    items.push({
      key: "otp",
      node: (
        <Input
          autoFocus
          inputMode="numeric"
          maxLength={6}
          onChange={(e) => setMfaTotpCode(e.target.value)}
          placeholder="123456"
          value={mfaTotpCode}
        />
      ),
    });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Sign in"}
        </Button>
      ),
    });
  }

  if (view === "forgot") {
    items.push({ key: "email", node: emailField("email") });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Send reset code"}
        </Button>
      ),
    });
    items.push({
      key: "forgot-back",
      node: (
        <button
          className="text-center text-muted-foreground text-sm hover:text-foreground"
          onClick={() => {
            setError("");
            setView("main");
          }}
          type="button"
        >
          Back to sign in
        </button>
      ),
    });
  }

  if (view === "reset") {
    items.push({
      key: "otp",
      node: (
        <Input
          inputMode="numeric"
          maxLength={6}
          onChange={(e) => setOtp(e.target.value)}
          placeholder="Reset code"
          value={otp}
        />
      ),
    });
    items.push({
      key: "new-password",
      node: (
        <Input
          autoComplete="new-password"
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
          type="password"
          value={newPassword}
        />
      ),
    });
    items.push({
      key: "confirm-password",
      node: (
        <Input
          autoComplete="new-password"
          onChange={(e) => setConfirmNewPassword(e.target.value)}
          placeholder="Confirm new password"
          type="password"
          value={confirmNewPassword}
        />
      ),
    });
    items.push({
      key: "submit",
      node: (
        <Button className="w-full" disabled={loading} type="submit">
          {loading ? <Spinner className="size-4" /> : "Reset password"}
        </Button>
      ),
    });
  }

  if (error) {
    items.push({
      key: "error",
      node: <p className="text-destructive text-sm">{error}</p>,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={onSubmit}>
        <motion.div
          animate={{ height }}
          className="overflow-hidden"
          initial={false}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          <div className="flex flex-col gap-3" ref={contentRef}>
            <AnimatePresence initial={false} mode="popLayout">
              {items.map(({ key, node }) => (
                <motion.div
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0 } }}
                  initial={{ opacity: 0 }}
                  key={key}
                  layout
                  transition={{
                    layout: { duration: 0.25, ease: "easeInOut" },
                    opacity: { duration: 0.15, delay: 0.25 },
                  }}
                >
                  {node}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      </form>
    </div>
  );
}
