import type { ReactNode } from "react";

export const metadata = { title: "Merchant explorer", description: "Every merchant in the Leash registry, with live health from verified evidence on Arkiv, ENSv2 and Hedera." };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
