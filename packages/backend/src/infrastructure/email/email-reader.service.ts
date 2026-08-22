import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ImapFlow, type ImapFlowOptions } from "imapflow";

/**
 * EmailReaderService — reads verification codes from email via IMAP.
 *
 * Used by SessionsService to automatically retrieve X (or other network)
 * verification codes when auto-login hits a 2FA/challenge page.
 *
 * Performance improvements:
 *   - Reuses a single IMAP connection between polling cycles instead of
 *     opening/closing a connection per poll.
 *   - Tracks the highest processed UID so each poll only fetches messages
 *     that arrived after the last successful read (no stale codes).
 *   - Closes the connection after an idle period and reconnects on demand.
 *
 * Config (env):
 *   EMAIL_IMAP_HOST=imap.gmail.com
 *   EMAIL_IMAP_PORT=993
 *   EMAIL_USER=you@gmail.com
 *   EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx  (Gmail App Password, not regular password)
 *   EMAIL_FROM_FILTER=info@x.com        (sender filter, default: x.com)
 *   EMAIL_IMAP_IDLE_TIMEOUT_MS=300000   (default 5 min)
 *
 * Gmail setup:
 *   1. Enable 2FA on your Google account
 *   2. Generate an App Password: https://myaccount.google.com/apppasswords
 *   3. Use that 16-char password (no spaces) as EMAIL_PASSWORD
 */
@Injectable()
export class EmailReaderService {
  private readonly logger = new Logger(EmailReaderService.name);
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly password: string;
  private readonly fromFilter: string;
  private readonly idleTimeoutMs: number;

  private client: ImapFlow | null = null;
  private lastSeenUid = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly configService: ConfigService) {
    this.host = this.configService.get<string>("EMAIL_IMAP_HOST", "imap.gmail.com");
    this.port = Number(this.configService.get<string>("EMAIL_IMAP_PORT", "993"));
    this.user = this.configService.get<string>("EMAIL_USER", "");
    this.password = this.configService.get<string>("EMAIL_PASSWORD", "");
    this.fromFilter = this.configService.get<string>("EMAIL_FROM_FILTER", "x.com");
    this.idleTimeoutMs = this.parseIdleTimeout();
    this.enabled = !!(this.user && this.password);
  }

  /**
   * Fetch the latest verification code from email.
   *
   * Reuses an existing IMAP connection between calls. Tracks the highest
   * processed UID and only fetches messages with a higher UID, which prevents
   * returning stale verification codes on subsequent polls.
   *
   * @param sinceMs  Only consider emails newer than this (Date.now() - sinceMs).
   *                 Default: 5 minutes ago (codes expire quickly).
   * @returns The verification code string, or null if not found.
   */
  async fetchVerificationCode(sinceMs = 300000): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug("Email reader disabled — EMAIL_USER/EMAIL_PASSWORD not set");
      return null;
    }

    this.resetIdleTimer();
    let lock: { release(): void } | undefined;
    try {
      const client = await this.ensureClient();

      // Open INBOX
      lock = await client.getMailboxLock("INBOX");
      try {
        // Search for recent emails from the configured sender, UID > last seen.
        // UIDs are stable across sessions and monotonically increasing, so they
        // are a reliable cursor for "new since last poll".
        const since = new Date(Date.now() - sinceMs);
        const searchQuery: Record<string, unknown> = {
          from: this.fromFilter,
          since,
        };
        if (this.lastSeenUid > 0) {
          searchQuery.uid = `${this.lastSeenUid + 1}:*`;
        }

        const messages = await client.search(searchQuery, { uid: true });

        if (!messages || messages.length === 0) {
          this.logger.debug(
            `No new emails from ${this.fromFilter} in the last ${Math.round(sinceMs / 1000)}s`,
          );
          return null;
        }

        // messages are UIDs (because of { uid: true }); they are sorted ascending.
        const latestUid = messages[messages.length - 1]!;
        this.logger.debug(`Fetching message UID ${latestUid} from ${this.fromFilter}`);

        const msg = await client.fetchOne(
          latestUid,
          { envelope: true, source: true, uid: true },
          { uid: true },
        );
        if (!msg) {
          this.logger.warn(`Could not fetch message UID ${latestUid}`);
          return null;
        }

        // Advance the cursor to the highest UID we observed in this search,
        // not just the one we fetched, so lower UIDs are skipped next poll.
        this.lastSeenUid = Math.max(this.lastSeenUid, ...messages);

        // Extract code from subject + body
        const subject = msg.envelope?.subject ?? "";
        const body =
          msg.source instanceof Buffer ? msg.source.toString("utf-8") : String(msg.source ?? "");
        const fullText = `${subject}\n${body}`;

        const code = this.extractCode(fullText);
        if (code) {
          this.logger.log(`Verification code extracted from email: subject="${subject}"`);
        } else {
          this.logger.warn(`Could not extract verification code from email: subject="${subject}"`);
        }
        return code;
      } finally {
        lock?.release();
      }
    } catch (err) {
      this.logger.warn(`IMAP error: ${(err as Error).message}`);
      // Drop the current connection so the next call reconnects fresh.
      await this.closeConnection();
      return null;
    } finally {
      this.scheduleIdleClose();
    }
  }

  /**
   * Poll for a verification code, checking every few seconds.
   * Useful when the email hasn't arrived yet — keeps checking until timeout.
   */
  async pollForVerificationCode(timeoutMs = 120000, intervalMs = 5000): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug("Email reader disabled — cannot poll for verification code");
      return null;
    }

    const startTime = Date.now();
    this.logger.log(
      `Polling email for verification code from ${this.fromFilter} ` +
        `(timeout: ${timeoutMs / 1000}s, interval: ${intervalMs / 1000}s)`,
    );

    while (Date.now() - startTime < timeoutMs) {
      const code = await this.fetchVerificationCode();
      if (code) {
        return code;
      }
      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    this.logger.warn(`No verification code found in email within ${timeoutMs / 1000}s`);
    return null;
  }

  /**
   * Ensure a usable IMAP connection exists, reconnecting if the previous
   * connection was closed or errored.
   */
  private async ensureClient(): Promise<ImapFlow> {
    if (this.client?.usable) {
      return this.client;
    }

    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // non-blocking
      }
      this.client = null;
    }

    this.client = new ImapFlow(this.getImapOptions());
    this.client.on("close", () => {
      this.logger.debug("IMAP connection closed");
      this.client = null;
    });
    this.client.on("error", (err: Error) => {
      this.logger.warn(`IMAP connection error: ${err.message}`);
      this.client = null;
    });

    await this.client.connect();
    this.logger.debug(`IMAP connected to ${this.host}:${this.port} as ${this.user}`);
    return this.client;
  }

  /**
   * Close the IMAP connection and clear any idle timeout.
   */
  private async closeConnection(): Promise<void> {
    this.resetIdleTimer();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.logout();
    } catch {
      // non-blocking
    }
  }

  /**
   * Reset the idle timeout whenever the connection is actively used.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Schedule a connection close after a period of inactivity. This prevents
   * holding an IMAP connection open forever when email is not being polled.
   */
  private scheduleIdleClose(): void {
    this.resetIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.logger.debug(`IMAP connection idle for ${this.idleTimeoutMs}ms — closing`);
      void this.closeConnection();
    }, this.idleTimeoutMs);
  }

  private parseIdleTimeout(): number {
    const raw = this.configService.get<string>("EMAIL_IMAP_IDLE_TIMEOUT_MS");
    if (!raw) return 300_000; // 5 minutes
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? 300_000 : parsed;
  }

  private getImapOptions(): ImapFlowOptions {
    return {
      host: this.host,
      port: this.port,
      secure: this.port === 993,
      auth: {
        user: this.user,
        pass: this.password,
      },
      logger: false, // disable imapflow's own logger
    };
  }

  /**
   * Extract a verification code from email text.
   * X typically sends codes as:
   *   - "Your confirmation code is 307097"
   *   - "Enter this code: 307097"
   *   - Just a 6-digit number in the subject or body
   *
   * Looks for 4-8 digit numbers, prioritizing patterns near keywords.
   */
  private extractCode(text: string): string | null {
    // Pattern 1: "code is 123456" / "code: 123456" / "code 123456"
    const codeKeywordPattern = /(?:code(?:\s+is)?|verification|confirm(?:ation)?)[\s:]*?(\d{4,8})/i;
    const keywordMatch = text.match(codeKeywordPattern);
    if (keywordMatch?.[1]) {
      return keywordMatch[1];
    }

    // Pattern 2: standalone 6-digit number (most common for X)
    const sixDigitPattern = /\b(\d{6})\b/;
    const sixMatch = text.match(sixDigitPattern);
    if (sixMatch?.[1]) {
      return sixMatch[1];
    }

    // Pattern 3: any 4-8 digit number
    const anyDigitPattern = /\b(\d{4,8})\b/;
    const anyMatch = text.match(anyDigitPattern);
    if (anyMatch?.[1]) {
      return anyMatch[1];
    }

    return null;
  }
}
