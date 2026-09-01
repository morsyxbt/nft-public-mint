// Turn whatever the user pastes into a mint target.
//
// Accepts an OpenSea URL (collection page, drop page, or item page), a bare
// collection slug, or a bare contract address. Item URLs also carry the chain,
// which we surface as a hint so the wizard can catch a chain mismatch before
// firing on the wrong network.

export interface LinkTarget {
  kind: "address" | "slug";
  value: string;
  chainHint?: string; // chain segment parsed out of an OpenSea URL, if present
  tokenId?: string;
}

// OpenSea's URL chain segment → our chain key (src/chains.ts).
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "ethereum",
  eth: "ethereum",
  mainnet: "ethereum",
  base: "base",
  robinhood: "robinhood",
};

function normalizeChain(segment: string): string {
  const key = segment.trim().toLowerCase();
  return CHAIN_ALIASES[key] ?? key;
}

function isContractAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function parseNftLink(input: string): LinkTarget {
  if (input == null) throw new Error("No NFT link provided");
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("No NFT link provided");

  // Bare contract address
  if (isContractAddress(raw)) {
    return { kind: "address", value: raw };
  }

  // Anything URL-shaped goes through the path parser
  if (/^https?:\/\//i.test(raw) || raw.toLowerCase().includes("opensea.io")) {
    return parseUrl(raw);
  }

  // Otherwise treat it as a collection slug
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    throw new Error(
      `Could not read "${input}" as an OpenSea link, collection slug, or contract address`
    );
  }
  return { kind: "slug", value: raw.toLowerCase() };
}

function parseUrl(raw: string): LinkTarget {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let segments: string[];
  try {
    segments = new URL(withProtocol).pathname
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    throw new Error(`Could not parse "${raw}" as a URL`);
  }

  // /assets/<chain>/<address>/<tokenId>  and  /item/<chain>/<address>/<tokenId>
  const itemIdx = segments.findIndex((s) => s === "assets" || s === "item");
  if (itemIdx >= 0) {
    const rest = segments.slice(itemIdx + 1);
    const addrIdx = rest.findIndex(isContractAddress);
    if (addrIdx >= 0) {
      return {
        kind: "address",
        value: rest[addrIdx],
        chainHint: addrIdx > 0 ? normalizeChain(rest[addrIdx - 1]) : undefined,
        tokenId: rest[addrIdx + 1],
      };
    }
  }

  // /collection/<slug>[/drop|/overview|...]
  const collectionIdx = segments.indexOf("collection");
  if (collectionIdx >= 0 && segments[collectionIdx + 1]) {
    const slug = segments[collectionIdx + 1];
    return {
      kind: "slug",
      value: slug.toLowerCase(),
      // /<chain>/collection/<slug> puts the chain ahead of the keyword
      chainHint: collectionIdx > 0 ? normalizeChain(segments[collectionIdx - 1]) : undefined,
    };
  }

  // Fall back to any contract address anywhere in the path
  const looseAddr = segments.find(isContractAddress);
  if (looseAddr) return { kind: "address", value: looseAddr };

  throw new Error(
    `No collection slug or contract address found in "${raw}" — paste the OpenSea collection or item link`
  );
}
