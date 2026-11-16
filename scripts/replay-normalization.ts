/**
 * Replays every stored listing through THIS commit's normalization rule. Offline: it reads a file
 * and prints; nothing here touches the network or the database.
 *
 *   npx wrangler d1 execute marketplace-deal-finder-db --remote --json \
 *     --command "SELECT listing_id,title,price_cents,component_type,validity,model_key FROM listings" \
 *     > listings.json
 *   node scripts/replay-normalization.ts listings.json
 *
 * It prints (a) the per-reason breakdown, (b) yield -- distinct listing_ids keyed, stored vs this
 * commit, (c) every row whose key, validity or type this commit would change, with its title, so
 * a gained key can be checked by hand, and (d) the unkeyed components to hand-label into catalog
 * candidates. See docs/collector-ingest.md, "How the coverage number IS obtained".
 *
 * RUN WITH PLAIN `node`, THE WAY THE COLLECTOR IS RUN. Node strips the types itself, but it will
 * not resolve the Worker's extensionless relative imports (`./catalogIndex`), which only a bundler
 * understands. The resolve hook below retries exactly those as `.ts`, and the rule itself is
 * imported only AFTER the hook is registered -- which is why that import is dynamic.
 */

import { readFileSync } from "node:fs";
import { register } from "node:module";

const RESOLVE_TS = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (error?.code === "ERR_MODULE_NOT_FOUND" && relative && !/\\.[cm]?[jt]s$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw error;
  }
}`;

const [path] = process.argv.slice(2);
if (path === undefined) {
  console.error("usage: node scripts/replay-normalization.ts <wrangler --json export of listings>");
  process.exit(2);
}

register(`data:text/javascript,${encodeURIComponent(RESOLVE_TS)}`, import.meta.url);
const { formatReport, parseD1Export, replay } = await import("../worker/normalize/replay.ts");

try {
  process.stdout.write(formatReport(replay(parseD1Export(readFileSync(path, "utf8")))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
