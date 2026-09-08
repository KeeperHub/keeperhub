"use client";

import { useSetAtom } from "jotai";
import { Copy, LogOut, Rocket, Settings, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectButton } from "@/components/auth/connect-button";
import {
  isAuthFlowInProgress,
  isSingleProviderSignInInitiated,
} from "@/components/auth/dialog";
import { ManageOrgsModal } from "@/components/organization/manage-orgs-modal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { signOut, useSession } from "@/lib/auth-client";
import {
  hasNotificationType,
  useNotificationStatus,
} from "@/lib/hooks/use-notifications";
import { useActiveMember, useOrganization } from "@/lib/hooks/use-organization";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { gettingStartedOpenAtom } from "@/lib/workflow/store";

export const UserMenu = (): React.ReactElement => {
  const { data: session, isPending } = useSession();
  const signInInProgress = isSingleProviderSignInInitiated();
  const authFlowInProgress = isAuthFlowInProgress();

  // Better Auth anonymous plugin creates users with name "Anonymous" and a
  // temp- email; anyone anonymous or not yet email-verified still needs the
  // Sign In surface. Shared with the onboarding tour via lib/is-new-user.
  const isAnonymous = isAnonymousUser(session?.user);

  // Wallet (SIWE) users authenticate by signature and never verify an email,
  // so they count as authenticated despite emailVerified being false.
  const isWalletUser = isWalletEmail(session?.user?.email);

  // While the session loader is pending the visitor's identity is not yet
  // known. On a hard refresh `session` is undefined, so a signed-in user
  // would briefly fall through to the Sign In button before their avatar
  // appears. Render a neutral avatar-shaped skeleton during that window
  // instead of flashing Sign In.
  //
  // Several cases must keep falling through so the AuthDialog stays mounted
  // across the brief refetch that Better Auth runs after a credential submit
  // or on tab focus (otherwise the post-credential email/totp view is dropped
  // before the user can see it): a single-provider auto-sign-in is mid-flight,
  // the dialog is on a verification step (email OTP / TOTP / signup verify),
  // or an *existing* anonymous session (session.user present) is being
  // refetched.
  if (isPending && !signInInProgress && !authFlowInProgress) {
    const anonymousSessionRefetching = Boolean(session?.user) && isAnonymous;
    if (!anonymousSessionRefetching) {
      return <Skeleton className="h-9 w-9 rounded-full" />;
    }
  }

  // NAV-04: only mount the authenticated dropdown when the user is signed in
  // and verified. The dropdown depends on `useOrganization` and
  // `useActiveMember`, which auto-fire protected fetches as soon as they are
  // called. Routing anonymous users through a separate sign-in surface keeps
  // the network log clean on initial load.
  if (isAnonymous || !(session?.user?.emailVerified || isWalletUser)) {
    return (
      <div className="flex items-center gap-2">
        <ConnectButton />
      </div>
    );
  }

  return <AuthenticatedUserMenu />;
};

const AuthenticatedUserMenu = (): React.ReactElement => {
  const { data: session } = useSession();
  // Wallet accounts carry a synthetic `<address>@wallet...` email; show the
  // truncated address instead so it doesn't overflow the menu.
  const email = session?.user?.email ?? "";
  // The full sign-in wallet address, checksummed, copyable from the menu
  // (wallet users only). Checksum before truncating so the shown short form
  // carries the correct EIP-55 casing too.
  const signinAddress = isWalletEmail(email)
    ? toChecksumAddress(email.split("@")[0])
    : null;
  const accountIdentifier = signinAddress
    ? truncateAddress(signinAddress)
    : email;
  const copySigninAddress = async (): Promise<void> => {
    if (!signinAddress) {
      return;
    }
    try {
      await navigator.clipboard.writeText(signinAddress);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy address");
    }
  };
  const [orgModalOpen, setOrgModalOpen] = useState(false);
  const { organization } = useOrganization();
  const { isOwner } = useActiveMember();
  const router = useRouter();
  const openGettingStarted = useSetAtom(gettingStartedOpenAtom);
  const { status: notificationStatus, refresh: refreshNotifications } =
    useNotificationStatus(isOwner ? organization?.id : null);
  const showAvatarDot = notificationStatus.unreadCount > 0;
  const showBillingDot = hasNotificationType(
    notificationStatus,
    "billing_limit_reached"
  );

  const handleDropdownOpenChange = (open: boolean): void => {
    if (open) {
      refreshNotifications().catch(() => undefined);
    }
  };

  const handleLogout = async (): Promise<void> => {
    await signOut();
    // Full page refresh to clear all React/jotai state
    window.location.href = "/";
  };

  const getUserInitials = (): string => {
    if (session?.user?.name) {
      return session.user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (session?.user?.email) {
      return session.user.email.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleDropdownOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={
              showAvatarDot ? "User menu, unread notifications" : "User menu"
            }
            className="relative h-9 w-9 rounded-full border p-0"
            data-testid="user-menu"
            variant="ghost"
          >
            <Avatar className="h-9 w-9">
              <AvatarImage
                alt={session?.user?.name || ""}
                src={session?.user?.image || ""}
              />
              <AvatarFallback>{getUserInitials()}</AvatarFallback>
            </Avatar>
            {showAvatarDot && (
              <span
                aria-hidden="true"
                className="absolute top-0 right-0 size-2.5 rounded-full bg-destructive ring-2 ring-background"
                data-testid="user-menu-notification-dot"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col space-y-1">
              <p className="truncate font-medium text-sm leading-none">
                {session?.user?.name || "User"}
              </p>
              {signinAddress ? (
                <button
                  aria-label="Copy address"
                  className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs leading-none transition-colors hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    copySigninAddress();
                  }}
                  type="button"
                >
                  <span className="truncate">{accountIdentifier}</span>
                  <Copy aria-hidden="true" className="size-3 shrink-0" />
                </button>
              ) : (
                <p className="truncate text-muted-foreground text-xs leading-none">
                  {accountIdentifier}
                </p>
              )}
            </div>
            <div className="h-8 w-px shrink-0 bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Account settings"
                  className="relative shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => router.push("/settings")}
                  type="button"
                >
                  <Settings className="size-4" />
                  {showBillingDot && (
                    <span
                      aria-hidden="true"
                      className="-top-0.5 -right-0.5 absolute size-2 rounded-full bg-destructive"
                      data-testid="billing-notification-dot"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Account settings</TooltipContent>
            </Tooltip>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="lg:hidden">
            <DropdownMenuItem
              onClick={() =>
                router.push(
                  organization?.id
                    ? `/settings/${organization.id}/organization`
                    : "/settings"
                )
              }
            >
              <Users className="size-4" />
              <span className="truncate">
                {organization?.name ?? "Organization"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </div>
          <DropdownMenuItem onClick={() => openGettingStarted(true)}>
            <Rocket className="size-4" />
            <span>Getting started</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="size-4" />
            <span>Logout</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Kept only to consume the `?digestSettings=<orgId>` deep link that
          existing digest emails still point at. Nothing opens it from here. */}
      <ManageOrgsModal
        consumeDeepLink
        onOpenChange={setOrgModalOpen}
        open={orgModalOpen}
      />
    </>
  );
};
