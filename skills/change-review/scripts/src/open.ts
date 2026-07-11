import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  if (process.env.CHANGE_REVIEW_NO_OPEN) return;
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Browser opening is best-effort; the URL is printed on stderr anyway.
  }
}
