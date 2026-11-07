import type { ReactNode } from "react";

export const metadata = { title: "Create a merchant", description: "List an ENS-verified merchant in the Leash registry: publish its policy to ENS, sign, and Leash writes the listing to Arkiv." };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
