import { TopBar } from "@/components/shell/TopBar";
import { ContributionForm } from "@/components/contribute/ContributionForm";

export const metadata = {
  title: "Contribute a question · Anvil",
  description: "Turn a real engineering interview question into a private, verified Anvil exercise.",
};

export default function Page() {
  return (
    <>
      <TopBar />
      <ContributionForm />
    </>
  );
}
