"use client";
import { useEffect, useState } from "react";
import { bytesToHex, createPublicClient, createWalletClient, custom, encodeFunctionData, parseAbi, type EIP1193Provider } from "viem";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { arkivEntity, Chip, CodeBlock, short } from "../../components/bits";
import { Icon } from "../../components/icons";

const resolverAbi = parseAbi(["function setText(bytes name, string key, string value)", "function multicall(bytes[] calls) returns (bytes[])"]);
const ETHERSCAN = "https://sepolia.etherscan.io";
const SEPOLIA = "0xaa36a7";
const ACCOUNT = /^0\.0\.\d{1,12}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SAMPLE = `{
  "name": "yourshop.eth",
  "payTo": "0.0.123456",
  "maxPrice": 0.25,
  "domains": ["https://yourshop.example"],
  "probeUrl": "https://yourshop.example/check",
  "schema": ["checkId", "result"]
}`;

type Form = { payTo: string; maxPrice: string; domains: string; probeUrl: string; schema: string };
const EMPTY: Form = { payTo: "", maxPrice: "0.25", domains: "", probeUrl: "", schema: "" };
const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const httpsOrigin = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
};

/** A policy file with friendly keys ({"payTo": …}) or the records themselves ({"leash.payTo": …}). */
function fromPolicy(j: any): Form {
  const pick = (k: string) => j?.[k] ?? j?.[`leash.${k}`];
  const s = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v));
  return { payTo: s(pick("payTo")), maxPrice: s(pick("maxPrice")) || EMPTY.maxPrice, domains: s(pick("domains")), probeUrl: s(pick("probeUrl")), schema: s(pick("schema")) };
}

/** The form as the leash.* records the guard reads. Network and asset are fixed: this registry is testnet only. */
function toRecords(f: Form, t: { network: string; asset: string }): [string, string][] {
  return [
    ["leash.payTo", f.payTo.trim()],
    ["leash.network", t.network],
    ["leash.asset", t.asset],
    ["leash.maxPrice", String(Number(f.maxPrice))],
    ["leash.domains", split(f.domains).map((d) => httpsOrigin(d) ?? d).join(",")],
    ["leash.schema", split(f.schema).join(",")],
    ["leash.probeUrl", f.probeUrl.trim()],
  ];
}

function problems(f: Form): string[] {
  const p: string[] = [];
  if (!ACCOUNT.test(f.payTo.trim())) p.push("payTo must be a Hedera account id such as 0.0.123456.");
  if (!(Number(f.maxPrice) > 0)) p.push("Max price must be a USD amount above 0.");
  const origins = split(f.domains).map(httpsOrigin);
  if (origins.some((o) => !o)) p.push("Each domain must be an https origin such as https://yourshop.example.");
  if (f.probeUrl.trim() && !origins.includes(httpsOrigin(f.probeUrl.trim()))) p.push("The probe URL must be https, on one of your domains.");
  if (split(f.schema).some((x) => !FIELD.test(x))) p.push("Response fields are names such as invoiceId, separated by commas.");
  return p;
}

function wallet(): EIP1193Provider {
  const p = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!p) throw new Error("No browser wallet found. Install MetaMask or another wallet, then reload this page.");
  return p;
}

export default function NewMerchant() {
  const [ns, setNs] = useState("");
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [ens, setEns] = useState("");
  const [check, setCheck] = useState<any>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<{ at: string; msg: string } | null>(null);
  const [publishTx, setPublishTx] = useState("");
  const [done, setDone] = useState<any>(null);

  useEffect(() => setNs(new URLSearchParams(location.search).get("ns") ?? ""), []);

  const run = (at: string, fn: () => Promise<void>) => async () => {
    setBusy(at);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr({ at, msg: e?.shortMessage ?? e?.message ?? String(e) });
    } finally {
      setBusy("");
    }
  };
  const Err = ({ at }: { at: string }) => (err?.at === at ? <p className="err" role="alert">{err.msg}</p> : null);

  async function lookup(name = check?.ens ?? ens) {
    const q = new URLSearchParams({ ens: name.trim().toLowerCase(), ...(account ? { address: account } : {}), ...(ns ? { ns } : {}) });
    const res = await fetch(`/api/merchants?${q}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  const connect = run("connect", async () => {
    const p = wallet();
    const [a] = (await p.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA }] });
    setAccount(a ?? null);
  });

  const verify = run("verify", async () => {
    const c = await lookup(ens);
    setCheck(c);
    setDone(null);
    setPublishTx("");
    setForm(fromPolicy(c.records));
  });

  const upload = async (file?: File) => {
    if (!file) return;
    setErr(null);
    try {
      const j = JSON.parse(await file.text());
      setForm(fromPolicy(j));
      if (typeof j?.name === "string" && j.name !== check?.ens) setErr({ at: "policy", msg: `This file is for ${j.name}, not ${check?.ens}. Its policy was loaded anyway.` });
    } catch {
      setErr({ at: "policy", msg: "That file is not valid JSON." });
    }
  };

  const verified = check?.canWrite === true;
  const issues = problems(form);
  const records = check ? toRecords(form, check.testnet) : [];
  const changed = records.filter(([k, v]) => (check.records[k] ?? "") !== v);

  const publish = run("publish", async () => {
    const p = wallet();
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA }] });
    const version = String(Math.floor(Date.now() / 1000));
    const name = bytesToHex(packetToBytes(check.ens));
    const calls = [...changed, ["leash.policyVersion", version]].map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [name, k!, v!] }));
    const hash = await createWalletClient({ chain: sepolia, transport: custom(p), account: account! }).writeContract({ address: check.resolver, abi: resolverAbi, functionName: "multicall", args: [calls] });
    setPublishTx(hash);
    const receipt = await createPublicClient({ chain: sepolia, transport: custom(p) }).waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction reverted: this wallet may have lost its role on the resolver.");
    // The server reads through its own RPC, which can trail by a block: wait until it sees the new version.
    for (let i = 0; i < 10; i++) {
      const c = await lookup();
      if (c.records["leash.policyVersion"] === version) return setCheck(c);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Published, but Sepolia has not shown the new records yet. Wait a few seconds, then press Verify again.");
  });

  const sign = run("list", async () => {
    const c = await lookup();
    if (!c.message) throw new Error("This name has no valid Leash policy on ENS yet. Publish one first.");
    const signature = await createWalletClient({ chain: sepolia, transport: custom(wallet()), account: account! }).signMessage({ account: account!, message: c.message });
    const res = await fetch("/api/merchants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ens: c.ens, address: account, signedAt: c.signedAt, signature, ns: c.ns }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setDone(body);
  });

  const field = (k: keyof Form, label: string, hint: string, placeholder: string) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-describedby={`${k}-hint`} />
      <span id={`${k}-hint`} className="muted" style={{ fontSize: "0.85rem" }}>{hint}</span>
    </div>
  );

  return (
    <div>
      <div className="section-head">
        <div>
          <span className="kicker">Merchants · ENS verified · testnet</span>
          <h1 style={{ marginTop: 12 }}>Create a merchant</h1>
          <p className="lead">List your shop in the registry agents check before they pay. Prove that your wallet controls your ENSv2 name on Sepolia, publish your Leash policy to its records, then sign. Leash checks the name, the policy and your live endpoint before it writes the listing to Arkiv.</p>
        </div>
        <a className="btn" href={`/explorer${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`}><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><Icon name="arrow" /></span> Back to explorer</a>
      </div>

      {check && !check.open && <div className="banner alert" role="status"><Icon name="alert" /><span>The listing desk is closed on this deployment: it holds no registrar key. You can still publish your policy to ENS.</span></div>}

      <div className="stack">
        <section className="glass panel" aria-labelledby="s1">
          <h2 id="s1">1 · Prove you control the name</h2>
          {account ? (
            <p>Wallet <span className="mono">{short(account, 6)}</span> on Sepolia.</p>
          ) : (
            <p><button type="button" className="primary" onClick={connect} disabled={busy === "connect"}>{busy === "connect" ? "Connecting…" : "Connect wallet"}</button> <span className="muted">MetaMask or any browser wallet, on Sepolia</span></p>
          )}
          <Err at="connect" />
          <form className="search" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <div className="field" style={{ flex: "1 1 260px" }}>
              <label htmlFor="ens">Your ENS name</label>
              <input id="ens" value={ens} onChange={(e) => setEns(e.target.value)} placeholder="yourshop.eth" autoComplete="off" spellCheck={false} />
            </div>
            <button type="submit" disabled={!account || !ens.trim() || busy === "verify"}>{busy === "verify" ? "Checking…" : "Verify"}</button>
          </form>
          <Err at="verify" />
          {check && (
            <div style={{ marginTop: 12 }}>
              {verified ? (
                <Chip v="pass">This wallet can set records on {check.ens}</Chip>
              ) : (
                <>
                  <Chip v="fail">This wallet cannot set records on {check.ens}</Chip>
                  <p className="muted">Listing needs the ENSv2 text role (ROLE_SET_TEXT) on the name's Permissioned Resolver. Connect the wallet that owns the name.</p>
                </>
              )}
              <dl className="kv">
                <dt>Resolver</dt>
                <dd><a className="mono" href={`${ETHERSCAN}/address/${check.resolver}`} target="_blank" rel="noreferrer">{short(check.resolver, 8)}</a></dd>
                <dt>Policy on ENS</dt>
                <dd>{check.declaration ? `pays ${check.declaration.payTo}, version ${check.declaration.policyVersion}` : "none yet"}</dd>
                {check.listed && <><dt>Listed</dt><dd>yes, policy version {check.listed.policyVersion} · <a href={arkivEntity(check.listed.key)} target="_blank" rel="noreferrer">Arkiv entity</a></dd></>}
              </dl>
            </div>
          )}
        </section>

        {verified && (
          <section className="glass panel" aria-labelledby="s2">
            <h2 id="s2">2 · Your merchant policy</h2>
            <div className="row start" style={{ marginBottom: 12 }}>
              <div className="field">
                <label htmlFor="policy-file">Upload a policy file</label>
                <input id="policy-file" type="file" accept="application/json,.json" onChange={(e) => upload(e.target.files?.[0])} />
              </div>
              <span className="muted">or fill it in below. Fields start from your current records.</span>
            </div>
            <details className="more" style={{ marginBottom: 12 }}>
              <summary>Policy file format</summary>
              <CodeBlock code={SAMPLE} label="leash-policy.json" lang="json" />
            </details>
            <Err at="policy" />
            <div className="stack">
              {field("payTo", "Hedera account (payTo)", "The only account agents may pay. Leash refuses a 402 that names any other.", "0.0.123456")}
              {field("maxPrice", "Max price per call, USD", "Agents treat any higher price as a policy violation.", "0.25")}
              {field("domains", "Domains", "The https origins that serve your API, separated by commas.", "https://yourshop.example")}
              {field("probeUrl", "Probe URL (optional)", "A paid route on one of your domains. Leash asks it without paying and expects a 402 naming your ENS name.", "https://yourshop.example/check")}
              {field("schema", "Response fields (optional)", "The fields every paid response carries. An empty or wrong response is a bad delivery.", "checkId, result")}
              <p className="muted" style={{ margin: 0 }}>Network and asset are fixed: Hedera testnet, USDC <span className="mono">{check.testnet.asset}</span>.</p>
            </div>
            {issues.length > 0 && <ul className="err" role="alert">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </section>
        )}

        {verified && (
          <section className="glass panel" aria-labelledby="s3">
            <h2 id="s3">3 · Publish it to ENS</h2>
            <div className="scroll">
              <table>
                <caption className="sr-only">The leash records for {check.ens}</caption>
                <thead><tr><th scope="col">Record</th><th scope="col">Value</th><th scope="col">On ENS</th></tr></thead>
                <tbody>
                  {records.map(([k, v]) => (
                    <tr key={k}>
                      <td className="mono">{k}</td>
                      <td className="mono" style={{ overflowWrap: "anywhere" }}>{v || "—"}</td>
                      <td>{(check.records[k] ?? "") === v ? <Chip v="pass">same</Chip> : <Chip v="pending">changes</Chip>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 12 }}>
              {changed.length ? (
                <button type="button" className="primary" onClick={publish} disabled={issues.length > 0 || !!busy}>{busy === "publish" ? "Publishing…" : `Publish ${changed.length} change${changed.length > 1 ? "s" : ""} with your wallet`}</button>
              ) : (
                <Chip v="pass">Your ENS records match this policy</Chip>
              )}
            </p>
            <p className="muted">One transaction to your own resolver, paid in Sepolia ETH. It also bumps leash.policyVersion, so agents know the policy changed.</p>
            {publishTx && <p>Transaction: <a className="mono" href={`${ETHERSCAN}/tx/${publishTx}`} target="_blank" rel="noreferrer">{short(publishTx, 8)}</a></p>}
            <Err at="publish" />
          </section>
        )}

        {verified && (
          <section className="glass panel" aria-labelledby="s4">
            <h2 id="s4">4 · Sign and list</h2>
            <p>Your wallet signs the policy as it stands on ENS. Leash checks the signature, your role on the resolver{form.probeUrl.trim() ? ", and that your probe URL answers 402 for this name and account," : ""} then writes the listing to Arkiv{check.ns ? <> in <strong>{check.ns}</strong></> : null}. No gas from you.</p>
            <button type="button" className="primary" onClick={sign} disabled={!check.open || changed.length > 0 || issues.length > 0 || !!busy}>{busy === "list" ? "Checking and listing…" : "Sign and list"}</button>
            {changed.length > 0 && <span className="muted" style={{ marginLeft: 10 }}>Publish your changes first.</span>}
            <Err at="list" />
            {done && (
              <div className="banner" role="status" style={{ marginTop: 14, marginBottom: 0 }}>
                <Icon name="check" />
                <div>
                  <strong>{check.ens} is a verified merchant{done.existing ? " (this policy was already listed)" : ""}.</strong>
                  <dl className="kv">
                    <dt>Arkiv entity</dt>
                    <dd><a className="mono" href={arkivEntity(done.entityKey)} target="_blank" rel="noreferrer">{short(done.entityKey, 8)}</a></dd>
                    {done.txHash && <><dt>Arkiv transaction</dt><dd><a className="mono" href={`https://rabdi.explorer.arkiv.network/tx/${done.txHash}`} target="_blank" rel="noreferrer">{short(done.txHash, 8)}</a></dd></>}
                    <dt>Endpoint</dt>
                    <dd>{done.endpoint === "verified" ? `verified: it asks ${done.priceUsd != null ? `$${done.priceUsd}` : "payment"} to ${check.declaration?.payTo} and claims ${check.ens}` : "none declared"}</dd>
                  </dl>
                  <a className="btn primary" href={`/explorer?q=${encodeURIComponent(check.ens)}${done.ns ? `&ns=${encodeURIComponent(done.ns)}` : ""}`}>See it in the explorer</a>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
