import type { Metadata } from "next";
import { TopBar } from "@/components/shell/TopBar";
import { SignInPanel } from "@/components/auth/SignInPanel";
import { isSignInStatus } from "@/lib/authStatus";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · Anvil",
  description: "Keep your Anvil history when this browser forgets it.",
};

/**
 * The sign-in page.
 *
 * Two jobs: somewhere to start sign-in from outside the top bar, and somewhere
 * for a failed magic link to land. A dead link has to explain itself on a page —
 * the user arrived by navigation from their mail client, so a JSON error or a
 * silent bounce to the home page tells them nothing.
 */
export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const { status } = await searchParams;
  const value = Array.isArray(status) ? status[0] : status;
  return (
    <>
      <TopBar />
      <SignInPanel status={isSignInStatus(value) ? value : null} />
    </>
  );
}
