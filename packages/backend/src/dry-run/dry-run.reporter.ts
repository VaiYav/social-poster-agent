// DryRunReporter — formats dry-run verification results as a readable report.
//
// Usage:
//   const reporter = new DryRunReporter();
//   reporter.startFeature('Generation (LLM)');
//   reporter.step('ok', 'LLM call succeeded', { provider: 'groq', tokens: 147 });
//   reporter.step('dry-run', 'Submit intercepted');
//   reporter.endFeature();
//   reporter.summary();

type StepStatus = 'ok' | 'fail' | 'dry-run' | 'warn';

interface Step {
  status: StepStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface Feature {
  name: string;
  steps: Step[];
  passed: boolean;
}

const ICONS: Record<StepStatus, string> = {
  ok: '\u2713', // ✓
  fail: '\u2717', // ✗
  'dry-run': '\u2299', // ⊙
  warn: '\u26a0', // ⚠
};

const COLORS: Record<StepStatus, string> = {
  ok: '\x1b[32m', // green
  fail: '\x1b[31m', // red
  'dry-run': '\x1b[33m', // yellow
  warn: '\x1b[33m', // yellow
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

export class DryRunReporter {
  private features: Feature[] = [];
  private currentFeature: Feature | null = null;

  startFeature(name: string): void {
    this.currentFeature = { name, steps: [], passed: true };
    console.log(`\n${BOLD}\u25b6 ${name}${RESET}`);
  }

  step(status: StepStatus, message: string, details?: Record<string, unknown>): void {
    if (!this.currentFeature) return;
    const step: Step = { status, message, details };
    this.currentFeature.steps.push(step);
    if (status === 'fail') this.currentFeature.passed = false;

    const icon = ICONS[status];
    const color = COLORS[status];
    console.log(`  ${color}${icon}${RESET} ${message}`);

    if (details) {
      for (const [key, value] of Object.entries(details)) {
        const formatted = typeof value === 'string' ? value : JSON.stringify(value);
        const truncated = formatted.length > 120 ? `${formatted.slice(0, 117)}...` : formatted;
        console.log(`    ${DIM}${key}: ${truncated}${RESET}`);
      }
    }
  }

  endFeature(): void {
    if (!this.currentFeature) return;
    const status = this.currentFeature.passed
      ? `${COLORS.ok}PASS${RESET}`
      : `${COLORS.fail}FAIL${RESET}`;
    console.log(`  ${DIM}[${status}${DIM}]${RESET}`);
    this.features.push(this.currentFeature);
    this.currentFeature = null;
  }

  banner(title: string): void {
    const width = 60;
    const padding = Math.max(0, width - title.length - 2);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    console.log(`\n${BOLD}${'='.repeat(width)}${RESET}`);
    console.log(`${BOLD}${'='.repeat(leftPad)} ${title} ${'='.repeat(rightPad)}${RESET}`);
    console.log(`${BOLD}${'='.repeat(width)}${RESET}`);
  }

  info(message: string): void {
    console.log(`${DIM}${message}${RESET}`);
  }

  summary(): { total: number; passed: number; failed: number } {
    const total = this.features.length;
    const passed = this.features.filter((f) => f.passed).length;
    const failed = total - passed;

    console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`);
    if (failed === 0) {
      console.log(`${BOLD}${COLORS.ok}  Summary: ${passed}/${total} features verified \u2713${RESET}`);
    } else {
      console.log(`${BOLD}${COLORS.fail}  Summary: ${passed}/${total} features passed, ${failed} failed \u2717${RESET}`);
    }
    console.log(`${DIM}  Dry-run completed \u2014 no posts were published${RESET}`);
    console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`);

    return { total, passed, failed };
  }
}
