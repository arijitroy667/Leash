import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { PUBLIC_MODE } from "../lib/server"; // also loads the repo's .env on the operator machine
import { Footer } from "./components/footer";
import { Nav } from "./components/nav";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Leash: payee safety for AI agents on x402", template: "%s · Leash" },
  description: "A shared, proof-of-payment-backed safety registry and guard for AI agents paying over x402. Live on Hedera, Arkiv and ENSv2.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f3efe6" }, { media: "(prefers-color-scheme: dark)", color: "#0b0a11" }],
};

// Applied before the first paint, so a saved theme never flashes the other one.
const THEME = `try{var t=localStorage.getItem("leash-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const publicMode = PUBLIC_MODE;
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <Nav publicMode={publicMode} />
        <main id="main" tabIndex={-1}>{children}</main>
        <Footer topic={process.env.HCS_TOPIC_ID} />
      </body>
    </html>
  );
}
