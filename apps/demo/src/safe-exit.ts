// Import first in any script that holds keys. RPC errors quote their URL, and the Arkiv URL carries the access key,
// so a crash is printed cleaned, never raw (NFR-05).
import { safeError } from "@leash/guard";

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (e) => {
    console.error(`failed: ${safeError(e)}`);
    process.exit(1);
  });
}
