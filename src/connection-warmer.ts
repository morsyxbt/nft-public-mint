import { log } from "./logger";

// Pre-establish TCP/TLS to every RPC so the first real request doesn't pay for
// a handshake. Some endpoints (Base's sequencer, for one) only accept send
// methods, so we warm with eth_sendRawTransaction and ignore the error — the
// handshake is the point, not the response.
export async function warmConnections(rpcUrls: string[]): Promise<void> {
  log("INFO", "Warming RPC connections...");

  await Promise.all(
    rpcUrls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: ["0x00"],
          id: 1,
        }),
      })
        .then(() => {})
        .catch(() => {})
    )
  );

  log("INFO", "Connections ready.");
}
