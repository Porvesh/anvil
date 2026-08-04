import { TopBar } from "@/components/shell/TopBar";
import { History } from "@/components/history/History";
import { isSignInStatus } from "@/lib/authStatus";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "History · Anvil",
  description: "The problems you've attempted, with the score each one earned.",
};

/**
 * Attempt history, and where a completed sign-in lands.
 *
 * Nothing is rendered on the server: the anonymous session id lives in
 * localStorage, so the component fetches its own rows and learns from that same
 * response whether the request was authenticated.
 */
export default async function Page({ searchParams }: PageProps<"/history">) {
  const { status } = await searchParams;
  const value = Array.isArray(status) ? status[0] : status;
  return (
    <>
      <TopBar />
      <History signInStatus={isSignInStatus(value) ? value : null} />
    </>
  );
}
