// Scene 7. The guard's real Arkiv traffic passes through this local forwarder when ARKIV_RPC_URL points
// at it. Stopping the process causes a genuine connection failure for the guard.
import "dotenv/config";
import { createServer } from "node:http";

const UPSTREAM = `https://rpc.rabdi.db-chain.testnet.arkiv.network/${encodeURIComponent(process.env.ARKIV_ACCESS_KEY ?? "")}`;
const PORT = Number(process.env.RELAY_PORT ?? 8765);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const r = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  } catch {
    res.destroy();
  }
}).listen(PORT, () => console.log(`Relay on http://localhost:${PORT}. Set ARKIV_RPC_URL to this, then press Ctrl+C to cut Arkiv.`));
