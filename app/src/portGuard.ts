/**
 * The port a process binds and the URL it advertises must name the same
 * listener.
 *
 * A shell script that expands `${APP_PORT:-4100}` is reading the shell's
 * environment, not `.env`, so a process can bind the port `.env` names while
 * telling LangWatch to deliver to the default one. Deliveries then go to a
 * port nothing is listening on, and the symptom is a webhook that never
 * arrives rather than a number that disagrees. Every entry point states both
 * and refuses to start when they disagree.
 */
export function assertAdvertisedPortMatches({
  label,
  boundPort,
  advertisedUrl,
}: {
  label: string;
  boundPort: number;
  advertisedUrl: string;
}): void {
  console.log(
    `[${label}] bound port ${boundPort}, advertised ${advertisedUrl}`,
  );

  let url: URL;
  try {
    url = new URL(advertisedUrl);
  } catch {
    throw new Error(
      `${label}: ${advertisedUrl} is not a valid URL. Fix the public URL in .env.`,
    );
  }

  // A tunnel or a public hostname legitimately names another port: it is
  // some other listener forwarding here. Only a loopback URL is claiming to
  // be this very process, so only that claim can be checked.
  if (!isLoopbackHost(url.hostname)) return;

  const advertisedPort = Number(
    url.port !== "" ? url.port : url.protocol === "https:" ? 443 : 80,
  );
  if (advertisedPort === boundPort) return;

  throw new Error(
    `${label}: advertised ${advertisedUrl} but bound port ${boundPort}. ` +
      "Point the port and the public URL at the same listener in .env " +
      "(APP_PORT with APP_PUBLIC_URL, APP_PY_PORT with APP_PY_PUBLIC_URL).",
  );
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
