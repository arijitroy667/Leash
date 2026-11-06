import Link from "next/link";

export const REPO = "https://github.com/arijitroy667/Leash";

export function Footer({ topic }: { topic?: string }) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <strong style={{ fontSize: "1.1rem" }}>Leash</strong>
          <p className="muted" style={{ marginTop: 6 }}>A shared, proof-of-payment-backed payee-safety registry and guard for AI agents paying over x402. Built at ETHGlobal Mumbai.</p>
        </div>
        <nav aria-label="Product">
          <p className="label">Product</p>
          <ul>
            <li><Link href="/demo">Live demo</Link></li>
            <li><Link href="/explorer">Merchant explorer</Link></li>
            <li><Link href="/docs">Docs</Link></li>
            <li><Link href="/integrate">SDK and MCP</Link></li>
          </ul>
        </nav>
        <nav aria-label="Proof">
          <p className="label">Live on testnets</p>
          <ul>
            {topic && <li><a href={`https://hashscan.io/testnet/topic/${topic}`} target="_blank" rel="noreferrer">HCS audit topic {topic}</a></li>}
            <li><a href={`${REPO}/blob/master/arkiv/schema.md`} target="_blank" rel="noreferrer">Arkiv schema</a></li>
            <li><a href="https://sepolia.etherscan.io/address/0x7f77622E13638dEd82B78C277d2B825d37E50300" target="_blank" rel="noreferrer">ENSv2 resolver on Sepolia</a></li>
          </ul>
        </nav>
        <div>
          <p className="label">Open source</p>
          <ul>
            <li><a href={REPO} target="_blank" rel="noreferrer">GitHub repository</a></li>
            <li>MIT licence</li>
            <li className="muted">Built with Claude Code under the team&apos;s direction</li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
