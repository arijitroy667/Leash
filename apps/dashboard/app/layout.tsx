import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Herd Immunity", description: "A shared payee-safety registry for x402 agents" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
