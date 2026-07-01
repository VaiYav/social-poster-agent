import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';

/**
 * EmailReaderService — reads verification codes from email via IMAP.
 *
 * Used by SessionsService to automatically retrieve X (or other network)
 * verification codes when auto-login hits a 2FA/challenge page.
 *
 * Config (env):
 *   EMAIL_IMAP_HOST=imap.gmail.com
 *   EMAIL_IMAP_PORT=993
 *   EMAIL_USER=you@gmail.com
 *   EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx  (Gmail App Password, not regular password)
 *   EMAIL_FROM_FILTER=info@x.com        (sender filter, default: x.com)
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

  constructor() {
    this.host = process.env.EMAIL_IMAP_HOST ?? 'imap.gmail.com';
    this.port = Number(process.env.EMAIL_IMAP_PORT ?? '993');
    this.user = process.env.EMAIL_USER ?? '';
    this.password = process.env.EMAIL_PASSWORD ?? '';
    this.fromFilter = process.env.EMAIL_FROM_FILTER ?? 'x.com';
    this.enabled = !!(this.user && this.password);
  }

  /**
   * Fetch the latest verification code from email.
   *
   * Connects to IMAP, searches for recent unread emails from the configured
   * sender filter (default: x.com), extracts the numeric code from the
   * subject/body, and returns it.
   *
   * @param sinceMs  Only consider emails newer than this (Date.now() - sinceMs).
   *                 Default: 5 minutes ago (codes expire quickly).
   * @returns The verification code string, or null if not found.
   */
  async fetchVerificationCode(sinceMs = 300000): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug('Email reader disabled — EMAIL_USER/EMAIL_PASSWORD not set');
      return null;
    }

    const client = new ImapFlow(this.getImapOptions());
    try {
      await client.connect();
      this.logger.debug(`IMAP connected to ${this.host}:${this.port} as ${this.user}`);

      // Open INBOX
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Search for recent emails from the configured sender
        const since = new Date(Date.now() - sinceMs);
        const messages = await client.search({
          from: this.fromFilter,
          since,
        });

        if (!messages || messages.length === 0) {
          this.logger.debug(`No emails from ${this.fromFilter} in the last ${Math.round(sinceMs / 1000)}s`);
          return null;
        }

        // Fetch the latest matching message (highest sequence number)
        const latestSeq = messages[messages.length - 1]!;
        this.logger.debug(`Fetching message #${latestSeq} from ${this.fromFilter}`);

        const msg = await client.fetchOne(latestSeq, { envelope: true, source: true });
        if (!msg) {
          this.logger.warn(`Could not fetch message #${latestSeq}`);
          return null;
        }

        // Extract code from subject + body
        const subject = msg.envelope?.subject ?? '';
        const body = msg.source instanceof Buffer
          ? msg.source.toString('utf-8')
          : String(msg.source ?? '');
        const fullText = `${subject}\n${body}`;

        const code = this.extractCode(fullText);
        if (code) {
          this.logger.log(`Verification code extracted from email: subject="${subject}"`);
        } else {
          this.logger.warn(`Could not extract verification code from email: subject="${subject}"`);
        }
        return code;
      } finally {
        lock.release();
      }
    } catch (err) {
      this.logger.warn(`IMAP error: ${(err as Error).message}`);
      return null;
    } finally {
      try {
        await client.logout();
      } catch {
        // non-blocking
      }
    }
  }

  /**
   * Poll for a verification code, checking every few seconds.
   * Useful when the email hasn't arrived yet — keeps checking until timeout.
   */
  async pollForVerificationCode(
    timeoutMs = 120000,
    intervalMs = 5000,
  ): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug('Email reader disabled — cannot poll for verification code');
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
