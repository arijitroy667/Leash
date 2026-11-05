// Spike: the real schema query against live Arkiv, with no key and no funds.
import "../safe-exit.ts";
import { Arkiv } from "@leash/guard";
const a = new Arkiv(process.env.ARKIV_ACCESS_KEY ?? "", "dev");
console.log("reports", await a.reports("0.0.11286079"));
console.log("probes", await a.probes("0.0.11286079", []));
console.log("rebuttals", await a.rebuttals("0.0.11286079"));
process.exit(0);
