import ora from "ora";
import { info, warn } from "./logger";
import { nowMs } from "./clock";

export async function waitForMintTime(mintTime: Date, earlyFireMs: number = 0): Promise<void> {
  // Fire early by earlyFireMs — tx sits in mempool and lands the moment contract allows
  const fireTime = new Date(mintTime.getTime() - earlyFireMs);
  const now = new Date(nowMs());
  const diff = fireTime.getTime() - now.getTime();

  if (diff <= 0) {
    warn("Fire time already passed — sending immediately.");
    return;
  }

  info(`Mint time: ${mintTime.toISOString()}`);
  if (earlyFireMs > 0) {
    info(`Early fire: ${earlyFireMs}ms before mint → firing at ${fireTime.toISOString()}`);
  }
  info(`Now: ${now.toISOString()} | waiting ${Math.ceil(diff / 1000)}s`);

  // If more than 10 seconds away, show a countdown spinner
  if (diff > 10000) {
    const spinner = ora({
      text: formatCountdown(fireTime),
      color: "cyan",
    }).start();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const remaining = fireTime.getTime() - nowMs();

        if (remaining <= 5000) {
          clearInterval(interval);
          spinner.stop();
          resolve();
        } else {
          spinner.text = formatCountdown(fireTime);
        }
      }, 500);
    });
  }

  // Precise wait for the last few seconds using a tight loop
  const remaining = fireTime.getTime() - nowMs();
  if (remaining > 0) {
    if (remaining > 100) {
      await new Promise((resolve) =>
        setTimeout(resolve, remaining - 100)
      );
    }

    // Tight spin-wait for the final milliseconds
    while (nowMs() < fireTime.getTime()) {
      // Spin-wait — burns CPU but gives sub-ms precision
    }
  }

  info("FIRING");
}

function formatCountdown(target: Date): string {
  const diff = target.getTime() - nowMs();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (hours > 0) {
    return `  Waiting... ${hours}h ${minutes}m ${seconds}s remaining`;
  }
  if (minutes > 0) {
    return `  Waiting... ${minutes}m ${seconds}s remaining`;
  }
  return `  Waiting... ${seconds}s remaining`;
}
