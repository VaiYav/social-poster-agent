import { Logger } from "@nestjs/common";
import type { Locator, Page } from "../../../domain/ports/browser-primitives.js";
import type { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { ComposeDialogError } from "../../../domain/errors.js";
import type { SocialNetwork } from "../../../generated/prisma/client.js";

export interface XComposePageDependencies {
  readonly browser: IBrowserPort;
  readonly network: SocialNetwork;
  readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  readonly assertPageAlive: (page: Page, context: string) => void;
}

/** X composer editor page object: resilient text-entry and paste strategies. */
export class XComposePage {
  private readonly browser: IBrowserPort;
  private readonly network: SocialNetwork;
  private readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  private readonly assertPageAlive: (page: Page, context: string) => void;

  constructor(deps: XComposePageDependencies) {
    this.browser = deps.browser;
    this.network = deps.network;
    this.logger = deps.logger;
    this.assertPageAlive = deps.assertPageAlive;
  }
  normalizeText(text: string): string {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .normalize("NFKC");
  }

  async setText(page: Page, textbox: Locator, content: string): Promise<void> {
    const target = this.normalizeText(content);
    const marker = target.slice(0, 30);
    const hasTarget = (text: string): boolean => this.normalizeText(text).includes(marker);

    // Fail fast if the compose box is not in the DOM (e.g. X /compose/post
    // page served the "JavaScript is not available" noscript fallback).
    // Without this check, pressSequentially/keyboard.type can hang forever
    // waiting on a locator that matched no elements.
    const count = await textbox.count();
    if (count === 0) {
      this.logger.warn("X setComposeText: compose textbox is not present in DOM");
      throw new ComposeDialogError(this.network, "Compose textbox not found");
    }

    // Helper: focus the contenteditable and select all of its current contents.
    const focusAndSelect = async (): Promise<void> => {
      this.assertPageAlive(page, "focus textbox");
      await textbox.focus({ timeout: 5000 }).catch(() => {});
      this.assertPageAlive(page, "click textbox");
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await textbox
        .evaluate(
          (el: HTMLElement) => {
            el.focus();
            try {
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(el);
              sel?.removeAllRanges();
              sel?.addRange(range);
            } catch {
              // ignore
            }
          },
          { timeout: 5000 },
        )
        .catch(() => {});
      await this.browser.randomDelay(150, 300);
    };

    // Helper: clear the textbox via DOM so the next strategy starts from a
    // blank state (humanType does not select all before typing).
    const clearTextbox = async (): Promise<void> => {
      this.assertPageAlive(page, "clear textbox");
      await textbox
        .evaluate(
          (el: HTMLElement) => {
            el.focus();
            el.textContent = "";
            el.innerText = "";
            try {
              const sel = window.getSelection();
              if (sel) {
                sel.removeAllRanges();
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.addRange(range);
              }
            } catch {
              // ignore
            }
          },
          { timeout: 5000 },
        )
        .catch(() => {});
    };

    // Strategy 1: real key events via locator.pressSequentially.
    // X's composer (Lexical/DraftJS) only enables the Post button when it
    // processes the genuine beforeinput/input sequence produced by real key
    // events. Synthetic paste/execCommand/beforeinput dispatch leaves the DOM
    // text visible but the React editor state empty, so the button stays disabled.
    // focusAndSelect ensures any existing placeholder/content is replaced.
    this.logger.log("X setComposeText: typing via pressSequentially...");
    try {
      await focusAndSelect();
      this.assertPageAlive(page, "pressSequentially");
      await textbox.pressSequentially(content, { delay: 30, timeout: 30000 });
      await this.browser.randomDelay(500, 800);
      const typedText = await textbox.innerText().catch(() => "");
      if (hasTarget(typedText)) {
        this.logger.debug("X setComposeText via pressSequentially succeeded");
        return;
      }
    } catch (err) {
      this.logger.debug(`X setComposeText pressSequentially failed: ${(err as Error).message}`);
    }

    // Strategy 2: fallback to browser-port humanType (focus + click + pressSequentially
    // with a short timeout, then fill). Uses the same real key events, but the
    // port's implementation adds timeouts that prevent hanging on a dead page.
    this.logger.warn("X pressSequentially failed — falling back to browser.humanType");
    try {
      await clearTextbox();
      this.assertPageAlive(page, "humanType");
      await this.browser.humanType(textbox, content, { delayMs: 30 });
      await this.browser.randomDelay(500, 800);
      const typedText = await textbox.innerText().catch(() => "");
      if (hasTarget(typedText)) {
        this.logger.debug("X setComposeText via humanType succeeded");
        return;
      }
    } catch (err) {
      this.logger.debug(`X setComposeText humanType failed: ${(err as Error).message}`);
    }

    // Strategy 3: synthetic paste event. May insert text but usually does not
    // update the React editor state; kept only as a last resort for content
    // that cannot be typed (e.g. certain Unicode edge cases).
    this.logger.warn("X key typing failed — falling back to pasteContent");
    this.assertPageAlive(page, "pasteContent");
    const pasted = await this.paste(page, textbox, content);
    if (pasted) {
      const enteredText = await textbox.innerText().catch(() => "");
      if (hasTarget(enteredText)) {
        this.logger.debug("X setComposeText via pasteContent succeeded");
        return;
      }
    }

    throw new ComposeDialogError(this.network, "Could not enter text into compose box");
  }

  /**
   * Paste content into the compose textbox via a synthetic clipboard paste event.
   * Modeled after wingman-x's fillReplyComposer: selects all contents, dispatches
   * a ClipboardEvent with the text, and checks that the editor handled the event
   * (preventDefault) and that the final text actually contains the target content.
   *
   * Falls back to document.execCommand('insertText') if the editor did not handle
   * the synthetic paste.
   *
   * @returns true if the textbox contains the target content, false otherwise.
   */
  async paste(page: Page, textbox: Locator, content: string): Promise<boolean> {
    try {
      const target = this.normalizeText(content);
      const marker = target.slice(0, 30);
      const hasTarget = (text: string): boolean => this.normalizeText(text).includes(marker);

      await textbox.focus({ timeout: 5000 }).catch(() => {});
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await textbox
        .evaluate((el: HTMLElement) => {
          el.focus();
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel?.removeAllRanges();
            sel?.addRange(range);
          } catch {
            // ignore
          }
        })
        .catch(() => {});
      await this.browser.randomDelay(150, 300);

      const result = await textbox
        .evaluate((el: HTMLElement, text: string) => {
          return new Promise<{ cancelled: boolean; afterText: string }>((resolve) => {
            const dt = new DataTransfer();
            dt.setData("text/plain", text);
            const ev = new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: dt as unknown as ClipboardEventInit["clipboardData"],
            });
            const cancelled = !el.dispatchEvent(ev);
            requestAnimationFrame(() => {
              resolve({ cancelled, afterText: el.textContent ?? "" });
            });
          });
        }, content)
        .catch(() => ({ cancelled: false, afterText: "" }));

      if (hasTarget(result.afterText)) {
        this.logger.debug(
          `X pasteContent: DraftJS handled paste (cancelled=${result.cancelled}), text matches target`,
        );
        return true;
      }

      if (result.cancelled) {
        this.logger.debug(
          "X pasteContent: paste was cancelled but final text does not match target; will fallback",
        );
      } else {
        this.logger.debug(
          "X pasteContent: paste not handled by editor, trying execCommand insertText",
        );
      }

      // Fallback: execCommand('insertText', false, text) to replace the selection.
      await textbox
        .evaluate((el: HTMLElement, text: string) => {
          el.focus();
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel?.removeAllRanges();
            sel?.addRange(range);
          } catch {
            // ignore
          }
          document.execCommand("insertText", false, text);
        }, content)
        .catch(() => {});

      await this.browser.randomDelay(300, 600);
      const execText = await textbox.innerText().catch(() => "");
      if (hasTarget(execText)) {
        this.logger.debug("X pasteContent: execCommand insertText succeeded");
        return true;
      }

      this.logger.warn("X pasteContent failed — content not entered");
      return false;
    } catch (err) {
      this.logger.warn(`X pasteContent error: ${(err as Error).message}`);
      return false;
    }
  }
}
