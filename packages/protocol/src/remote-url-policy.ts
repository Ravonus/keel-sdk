/**
 * Whether a URL may be reached at all, and whether an allowlist admits it.
 *
 * Relocated here from `@keel/viewer`'s source-policy (pure URL algebra, no
 * viewer or DOM dependency) so the SDK, the MCP server, and any host can apply
 * exactly the same rules the resolver applies. There is deliberately one
 * implementation of "is this remote host permitted": a second one would drift,
 * and the two would disagree in the direction of whoever wrote the looser copy.
 *
 * The rules, in order:
 *   - the URL must parse, and must not carry credentials;
 *   - HTTPS only, unless private-network sources are explicitly permitted;
 *   - private, loopback, link-local, and carrier-grade-NAT hosts are refused
 *     unless explicitly permitted, so a document cannot use the reader's own
 *     network as an oracle;
 *   - an allowlist entry is either an origin+path prefix (`https://host/path/`)
 *     or a bare registrable host (`example.com`, which also admits its
 *     subdomains).
 *
 * An absent or empty allowlist means "no allowlist", not "deny everything".
 * Callers that need fail-closed behaviour on an empty list must say so
 * themselves; `keel-rpc-policy` is the one that does.
 */

function parseIpv4(hostname: string): readonly number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return octets;
}

function privateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] !== undefined && privateIpv4(parseIpv4(mapped[1]) ?? []);
}

export function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const ipv4 = parseIpv4(normalized);
  return (ipv4 !== undefined && privateIpv4(ipv4)) || privateIpv6(normalized);
}

function allowlistMatch(parsed: URL, entry: string): boolean {
  try {
    if (entry.startsWith("https://") || entry.startsWith("http://")) {
      const allowed = new URL(entry);
      const prefix = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
      return parsed.origin === allowed.origin && (parsed.pathname === allowed.pathname || parsed.pathname.startsWith(prefix));
    }
    return parsed.hostname === entry || parsed.hostname.endsWith(`.${entry}`);
  } catch {
    return false;
  }
}

export function remoteUrlAllowed(
  url: string,
  allowlist: readonly string[] | undefined,
  allowPrivateNetworkSources = false,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (parsed.protocol !== "https:" && !(allowPrivateNetworkSources && parsed.protocol === "http:")) return false;
  if (!allowPrivateNetworkSources && isPrivateNetworkHost(parsed.hostname)) return false;
  if (allowlist === undefined || allowlist.length === 0) return true;
  return allowlist.some((entry) => allowlistMatch(parsed, entry));
}
