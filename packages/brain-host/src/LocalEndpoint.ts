// The Brain Host talks only to inference servers the user hosts: this machine
// or a private network. Prompts carry world state, memories and conversations,
// so a public address is refused outright (there is no override).
import net from "node:net";

const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 8], // 10.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0x7f000000, 8], // 127.0.0.0/8
];

const v4 = (ip: string) =>
  ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;

function privateIp(host: string): boolean {
  if (net.isIPv4(host))
    return PRIVATE_V4.some(
      ([base, bits]) => v4(host) >>> (32 - bits) === base >>> (32 - bits),
    );
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    return (
      h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      (h.startsWith("::ffff:") && privateIp(h.slice(7)))
    );
  }
  return false;
}

/** Null if `url` is a local or private-network endpoint, else why it is not. */
export function remoteEndpointReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (privateIp(host)) return null;
  // Single-label and .local/.lan names resolve on the local network only.
  if (!host.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(host))
    return null;
  return `${host} is not a local or private-network address; the Brain Host only talks to self-hosted inference servers`;
}
