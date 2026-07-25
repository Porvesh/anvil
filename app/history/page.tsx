import { TopBar } from "@/components/shell/TopBar";
import { History } from "@/components/history/History";

export const metadata = {
  title: "History · Anvil",
  description: "The problems you've attempted on this browser, with the score each one earned.",
};

/**
 * Attempt history. There is nothing to render on the server: the anonymous
 * session id lives in localStorage, so the component fetches its own rows.
 */
export default function Page() {
  return (
    <>
      <TopBar />
      <History />
    </>
  );
}
