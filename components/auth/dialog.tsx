"use client";

import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { authClient, signIn, signUp } from "@/lib/auth-client";
import {
  getEnabledAuthProviders,
  getSingleProvider,
} from "@/lib/auth-providers";
import { setPendingClaim } from "@/lib/hooks/use-claim-workflow";
import { refetchOrganizations } from "@/lib/refetch-organizations";

const WORKFLOW_PATH_REGEX = /^\/workflows\/([^/]+)$/;

type AuthDialogProps = {
  children?: ReactNode;
};

type ModalView =
  | "signin"
  | "signup"
  | "verify"
  | "forgot-password"
  | "reset-password";

const VercelIcon = ({ className = "mr-2 h-3 w-3" }: { className?: string }) => (
  <svg
    aria-label="Vercel"
    className={className}
    fill="currentColor"
    role="img"
    viewBox="0 0 76 65"
  >
    <title>Vercel</title>
    <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
  </svg>
);

const GitHubIcon = () => (
  <svg
    aria-label="GitHub"
    className="mr-2 h-4 w-4"
    fill="currentColor"
    role="img"
    viewBox="0 0 24 24"
  >
    <title>GitHub</title>
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const GoogleIcon = () => (
  <svg
    aria-label="Google"
    className="mr-2 h-4 w-4"
    role="img"
    viewBox="0 0 24 24"
  >
    <title>Google</title>
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="currentColor"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="currentColor"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="currentColor"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="currentColor"
    />
  </svg>
);

type Provider = "email" | "github" | "google" | "vercel";

const getProviderIcon = (provider: Provider, compact = false) => {
  const iconClass = compact ? "size-3.5" : undefined;
  switch (provider) {
    case "vercel":
      return <VercelIcon className={iconClass} />;
    case "github":
      return <GitHubIcon />;
    case "google":
      return <GoogleIcon />;
    default:
      return null;
  }
};

const getProviderLabel = (provider: Provider) => {
  switch (provider) {
    case "vercel":
      return "Vercel";
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    default:
      return "Email";
  }
};

// Social buttons component
type SocialButtonsProps = {
  enabledProviders: { vercel: boolean; github: boolean; google: boolean };
  onSignIn: (provider: "github" | "google" | "vercel") => void;
  loadingProvider: "github" | "google" | "vercel" | null;
};

const SocialButtons = ({
  enabledProviders,
  onSignIn,
  loadingProvider,
}: SocialButtonsProps) => (
  <div className="flex flex-col gap-2">
    {enabledProviders.vercel && (
      <Button
        className="w-full"
        disabled={loadingProvider !== null}
        onClick={() => onSignIn("vercel")}
        type="button"
        variant="outline"
      >
        <VercelIcon />
        {loadingProvider === "vercel" ? "Loading..." : "Continue with Vercel"}
      </Button>
    )}
    {enabledProviders.github && (
      <Button
        className="w-full"
        disabled={loadingProvider !== null}
        onClick={() => onSignIn("github")}
        type="button"
        variant="outline"
      >
        <GitHubIcon />
        {loadingProvider === "github" ? "Loading..." : "Continue with GitHub"}
      </Button>
    )}
    {enabledProviders.google && (
      <Button
        className="w-full"
        disabled={loadingProvider !== null}
        onClick={() => onSignIn("google")}
        type="button"
        variant="outline"
      >
        <GoogleIcon />
        {loadingProvider === "google" ? "Loading..." : "Continue with Google"}
      </Button>
    )}
  </div>
);

// Sign In Form
type SignInFormProps = {
  email: string;
  password: string;
  error: string;
  loading: boolean;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCreateAccount: () => void;
  onForgotPassword: () => void;
};

const SignInForm = ({
  email,
  password,
  error,
  loading,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onCreateAccount,
  onForgotPassword,
}: SignInFormProps) => (
  <div className="space-y-4">
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="email">
          Email
        </Label>
        <Input
          id="email"
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="ml-1" htmlFor="password">
            Password
          </Label>
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={onForgotPassword}
            tabIndex={-1}
            type="button"
          >
            Forgot password?
          </button>
        </div>
        <Input
          id="password"
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Enter your password"
          required
          type="password"
          value={password}
        />
      </div>
      {error && <div className="text-destructive text-sm">{error}</div>}
      <Button className="w-full" disabled={loading} type="submit">
        {loading ? <Spinner className="mr-2 size-4" /> : null}
        Sign in
      </Button>
    </form>
    <div className="flex items-center justify-center gap-1 text-sm">
      <span className="text-muted-foreground">New here?</span>
      <button
        className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
        onClick={onCreateAccount}
        type="button"
      >
        Create account
      </button>
    </div>
  </div>
);

// Single provider button
let singleProviderSignInInitiated = false;
export const isSingleProviderSignInInitiated = () =>
  singleProviderSignInInitiated;

// Track verification state to persist through component remounts
let pendingVerifyEmail: string | null = null;
let pendingVerifyPassword: string | null = null;

type SingleProviderButtonProps = {
  provider: Provider;
  loadingProvider: "github" | "google" | "vercel" | null;
  onSignIn: (provider: "github" | "google" | "vercel") => Promise<void>;
};

const SingleProviderButton = ({
  provider,
  loadingProvider,
  onSignIn,
}: SingleProviderButtonProps) => {
  const [isInitiated, setIsInitiated] = useState(singleProviderSignInInitiated);
  const isLoading = loadingProvider === provider || isInitiated;

  const handleClick = () => {
    singleProviderSignInInitiated = true;
    setIsInitiated(true);
    onSignIn(provider as "github" | "google" | "vercel");
  };

  return (
    <Button
      className="h-9 gap-1.5 px-2 disabled:opacity-100 sm:px-3"
      disabled={isLoading}
      onClick={handleClick}
      size="sm"
      variant="default"
    >
      {isLoading ? (
        <Spinner className="size-3.5" />
      ) : (
        getProviderIcon(provider, true)
      )}
      <span className="text-sm">Sign In</span>
    </Button>
  );
};

// Helper functions
const getViewTitle = (view: ModalView) => {
  switch (view) {
    case "signin":
      return "Sign in";
    case "signup":
      return "Create account";
    case "verify":
      return "Verify your email";
    case "forgot-password":
      return "Reset password";
    case "reset-password":
      return "Set new password";
    default:
      return "Sign in";
  }
};

const getViewDescription = (view: ModalView, email?: string) => {
  switch (view) {
    case "signin":
      return "Sign in to your account to continue.";
    case "signup":
      return "Create your account to get started.";
    case "verify":
      return email
        ? `Enter the 6-digit code sent to ${email}`
        : "Enter the verification code sent to your email.";
    case "forgot-password":
      return "Enter your email to receive a password reset code.";
    case "reset-password":
      return email
        ? `Enter the 6-digit code sent to ${email} and your new password.`
        : "Enter the reset code and your new password.";
    default:
      return null;
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Auth dialog handles multiple views and flows
export const AuthDialog = ({ children }: AuthDialogProps) => {
  // Use lazy initialization to check for pending verification on mount/remount
  const [open, setOpen] = useState(() => pendingVerifyEmail !== null);
  const [view, setView] = useState<ModalView>(() =>
    pendingVerifyEmail === null ? "signin" : "verify"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verifyEmail, setVerifyEmail] = useState(
    () => pendingVerifyEmail || ""
  );
  const [verifyPassword, setVerifyPassword] = useState(
    () => pendingVerifyPassword || ""
  );
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loadingProvider, setLoadingProvider] = useState<
    "github" | "google" | "vercel" | null
  >(null);

  // Handle pending verification when component mounts/remounts
  // Do NOT clear pendingVerify* here - they must survive remounts caused by
  // session refetch on tab focus. They are cleared on successful verification
  // (handleVerifyOtp) or when the user navigates away (Back to sign in).
  useEffect(() => {
    if (pendingVerifyEmail) {
      setOpen(true);
      setView("verify");
      setVerifyEmail(pendingVerifyEmail);
      if (pendingVerifyPassword) {
        setVerifyPassword(pendingVerifyPassword);
      }
    }
  }, []);

  const enabledProviders = getEnabledAuthProviders();
  const singleProvider = getSingleProvider();
  const hasSocialProviders =
    enabledProviders.vercel ||
    enabledProviders.github ||
    enabledProviders.google;

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setVerifyEmail("");
    setVerifyPassword("");
    setOtp("");
    setError("");
    setForgotEmail("");
    setNewPassword("");
    setConfirmNewPassword("");
  };

  const getClaimContext = async () => {
    const workflowMatch = window.location.pathname.match(WORKFLOW_PATH_REGEX);
    if (!workflowMatch) {
      return null;
    }
    const currentSession = await authClient.getSession();
    const previousUserId = currentSession?.data?.user?.id;
    if (!previousUserId) {
      return null;
    }
    return { workflowId: workflowMatch[1], previousUserId };
  };

  const storeClaimIfNeeded = (
    claimContext: { workflowId: string; previousUserId: string } | null
  ) => {
    if (claimContext) {
      setPendingClaim(claimContext);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      pendingVerifyEmail = null;
      pendingVerifyPassword = null;
      setTimeout(() => {
        setView("signin");
        resetForm();
      }, 200);
    }
  };

  const handleSocialSignIn = async (
    provider: "github" | "google" | "vercel"
  ) => {
    try {
      setLoadingProvider(provider);
      const claimContext = await getClaimContext();
      storeClaimIfNeeded(claimContext);
      await signIn.social({ provider, callbackURL: window.location.pathname });
    } catch {
      toast.error(`Failed to sign in with ${getProviderLabel(provider)}`);
      setLoadingProvider(null);
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex auth flow with multiple verification paths
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const claimContext = await getClaimContext();

    try {
      const response = await signIn.email({ email, password });
      if (response.error) {
        const errorMsg = response.error.message || "Sign in failed";

        // Check if error is about unverified email
        if (
          errorMsg.toLowerCase().includes("verify") ||
          errorMsg.toLowerCase().includes("verification") ||
          errorMsg.toLowerCase().includes("not verified")
        ) {
          // Send new OTP and switch to verify view
          try {
            const otpResponse = await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
            });

            if (otpResponse.error) {
              toast.error(
                otpResponse.error.message || "Failed to send verification code"
              );
              setError(
                otpResponse.error.message || "Failed to send verification code"
              );
              setLoading(false);
              return;
            }

            setVerifyEmail(email);
            setVerifyPassword(password);
            setView("verify");
            setOtp("");
            pendingVerifyEmail = email;
            pendingVerifyPassword = password;

            toast.info("Please verify your email. A new code has been sent.", {
              duration: 5000,
            });
          } catch (otpErr) {
            const otpErrMsg =
              otpErr instanceof Error
                ? otpErr.message
                : "Failed to send verification code";
            toast.error(otpErrMsg);
            setError(otpErrMsg);
          }
          setLoading(false);
          return;
        }

        setError(errorMsg);
        return;
      }

      storeClaimIfNeeded(claimContext);

      await new Promise((resolve) => setTimeout(resolve, 300));
      await authClient.getSession();
      refetchOrganizations();

      toast.success("Signed in successfully!");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles signup with unverified user detection
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const signUpResponse = await signUp.email({
        email,
        password,
        name: email.split("@")[0],
      });

      if (signUpResponse.error) {
        const errorMsg = signUpResponse.error.message || "Sign up failed";

        // Check if error is about existing user (might be unverified)
        if (
          errorMsg.toLowerCase().includes("already") ||
          errorMsg.toLowerCase().includes("exists") ||
          errorMsg.toLowerCase().includes("duplicate")
        ) {
          // Try to send verification OTP - if user exists but unverified, this will work
          try {
            const otpResponse = await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
            });

            if (otpResponse.error) {
              // OTP send failed due to API error
              const otpErrMsg =
                otpResponse.error.message || "Failed to send verification code";
              toast.error(otpErrMsg);
              setError(
                "An account with this email already exists. Please sign in."
              );
              setLoading(false);
              return;
            }

            // OTP sent successfully - user exists but is unverified
            setVerifyEmail(email);
            setVerifyPassword(password);
            setView("verify");
            setOtp("");
            pendingVerifyEmail = email;
            pendingVerifyPassword = password;

            toast.info(
              "An account with this email already exists. Please verify your email.",
              { duration: 5000 }
            );
            setLoading(false);
            return;
          } catch (otpErr) {
            // OTP send failed - user is already verified or email send failed
            const otpErrMsg =
              otpErr instanceof Error
                ? otpErr.message
                : "Failed to send verification code";
            if (otpErrMsg.toLowerCase().includes("email")) {
              toast.error(otpErrMsg);
            }
            setError(
              "An account with this email already exists. Please sign in."
            );
            setLoading(false);
            return;
          }
        }

        setError(errorMsg);
        setLoading(false);
        return;
      }

      // Store email and password for verification view
      const signedUpEmail = email;
      const signedUpPassword = password;

      // Switch to verify view
      setLoading(false);
      setVerifyEmail(signedUpEmail);
      setVerifyPassword(signedUpPassword);
      setView("verify");
      setError("");
      setOtp("");

      // Store in module-level vars in case component remounts
      pendingVerifyEmail = signedUpEmail;
      pendingVerifyPassword = signedUpPassword;

      toast.success(
        `Verification code sent to ${signedUpEmail}. Please check your inbox.`,
        { duration: 5000 }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Capture claim context BEFORE verification (while still anonymous)
    const claimContext = await getClaimContext();

    try {
      const response = await authClient.emailOtp.verifyEmail({
        email: verifyEmail,
        otp,
      });

      if (response.error) {
        setError(response.error.message || "Verification failed");
        setLoading(false);
        return;
      }

      // Clear pending state
      pendingVerifyEmail = null;
      pendingVerifyPassword = null;

      // Auto sign-in after verification using stored password
      if (verifyPassword) {
        const signInResponse = await signIn.email({
          email: verifyEmail,
          password: verifyPassword,
        });

        if (signInResponse.error) {
          // Verification succeeded but sign-in failed - redirect to sign in
          toast.success("Email verified! Please sign in.");
          setView("signin");
          setEmail(verifyEmail);
          setPassword("");
          setOtp("");
          setLoading(false);
          return;
        }
      }

      // Store claim context after successful sign-in
      storeClaimIfNeeded(claimContext);

      // Refresh session
      await authClient.getSession();
      refetchOrganizations();

      toast.success("Email verified! You're now signed in.");
      setOpen(false);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await authClient.emailOtp.sendVerificationOtp({
        email: verifyEmail,
        type: "email-verification",
      });

      if (response.error) {
        const errorMsg = response.error.message || "Failed to resend code";
        setError(errorMsg);
        toast.error(errorMsg);
        setLoading(false);
        return;
      }

      toast.success("New verification code sent!");
      setLoading(false);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to resend code";
      setError(errorMsg);
      toast.error(errorMsg);
      setLoading(false);
    }
  };

  const handleForgotPasswordRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email: forgotEmail }),
      });

      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to send reset code");
      }

      toast.success("If an account exists, a reset code has been sent.");
      setView("reset-password");
      setOtp("");
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to send reset code";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
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
          email: forgotEmail,
          otp,
          newPassword,
        }),
      });

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to reset password");
      }

      toast.success("Password reset successfully! Please sign in.");
      setView("signin");
      setEmail(forgotEmail);
      resetForm();
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to reset password";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleResendForgotOtp = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email: forgotEmail }),
      });

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to resend code");
      }

      toast.success("New reset code sent!");
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to resend code";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  if (singleProvider && singleProvider !== "email") {
    return (
      <SingleProviderButton
        loadingProvider={loadingProvider}
        onSignIn={handleSocialSignIn}
        provider={singleProvider}
      />
    );
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        {children || (
          <Button size="sm" variant="default">
            Sign In
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{getViewTitle(view)}</DialogTitle>
          {getViewDescription(view, verifyEmail) && (
            <DialogDescription>
              {getViewDescription(view, verifyEmail)}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {view === "signin" && (
            <>
              {hasSocialProviders && enabledProviders.email && (
                <>
                  <SocialButtons
                    enabledProviders={enabledProviders}
                    loadingProvider={loadingProvider}
                    onSignIn={handleSocialSignIn}
                  />
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <Separator />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">
                        Or continue with email
                      </span>
                    </div>
                  </div>
                </>
              )}
              {hasSocialProviders && !enabledProviders.email && (
                <SocialButtons
                  enabledProviders={enabledProviders}
                  loadingProvider={loadingProvider}
                  onSignIn={handleSocialSignIn}
                />
              )}
              {enabledProviders.email && (
                <SignInForm
                  email={email}
                  error={error}
                  loading={loading}
                  onCreateAccount={() => {
                    setView("signup");
                    setError("");
                  }}
                  onEmailChange={setEmail}
                  onForgotPassword={() => {
                    setForgotEmail(email);
                    setView("forgot-password");
                    setError("");
                  }}
                  onPasswordChange={setPassword}
                  onSubmit={handleSignIn}
                  password={password}
                />
              )}
            </>
          )}

          {view === "signup" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleSignUp}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signup-email">
                    Email
                  </Label>
                  <Input
                    id="signup-email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={email}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signup-password">
                    Password
                  </Label>
                  <Input
                    id="signup-password"
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a password"
                    required
                    type="password"
                    value={password}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button className="w-full" disabled={loading} type="submit">
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Create account
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Already have an account?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                  }}
                  type="button"
                >
                  Sign in
                </button>
              </div>
            </div>
          )}

          {view === "verify" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleVerifyOtp}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="otp">
                    Verification Code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="otp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={otp}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={loading || otp.length !== 6}
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Verify
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Didn't receive the code?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  disabled={loading}
                  onClick={handleResendOtp}
                  type="button"
                >
                  Resend
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setOtp("");
                    pendingVerifyEmail = null;
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "forgot-password" && (
            <div className="space-y-4">
              <form
                className="space-y-4"
                onSubmit={handleForgotPasswordRequest}
              >
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="forgot-email">
                    Email
                  </Label>
                  <Input
                    autoFocus
                    id="forgot-email"
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={forgotEmail}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button className="w-full" disabled={loading} type="submit">
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Send Reset Code
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "reset-password" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handlePasswordReset}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="reset-otp">
                    Reset Code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="reset-otp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={otp}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="new-password">
                    New Password
                  </Label>
                  <Input
                    autoComplete="new-password"
                    id="new-password"
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password (min 8 characters)"
                    required
                    type="password"
                    value={newPassword}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="confirm-new-password">
                    Confirm New Password
                  </Label>
                  <Input
                    autoComplete="new-password"
                    id="confirm-new-password"
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    type="password"
                    value={confirmNewPassword}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={
                    loading ||
                    otp.length !== 6 ||
                    !newPassword ||
                    !confirmNewPassword
                  }
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Reset Password
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Didn't receive the code?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  disabled={loading}
                  onClick={handleResendForgotOtp}
                  type="button"
                >
                  Resend
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setOtp("");
                    setNewPassword("");
                    setConfirmNewPassword("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
