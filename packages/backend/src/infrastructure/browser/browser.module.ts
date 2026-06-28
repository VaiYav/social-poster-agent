import { Module } from '@nestjs/common';
import { BrowserFactory } from './browser.factory';
import { SelectorHealthService } from './selector-health.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';

@Module({
  providers: [
    BrowserFactory,
    SelectorHealthService,
    {
      provide: IBrowserPort,
      useFactory: (real: BrowserFactory) => {
        // Dry-run mode: wrap BrowserFactory with DryRunBrowserPort that intercepts submit clicks.
        // Lazy import to avoid circular dependency (DryRunBrowserPort imports BrowserFactory type).
        if (process.env.SPA_DRY_RUN === 'true') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { DryRunBrowserPort } = require('../../dry-run/dry-run.browser-port.js');
          return new DryRunBrowserPort(real);
        }
        return real;
      },
      inject: [BrowserFactory],
    },
  ],
  exports: [BrowserFactory, SelectorHealthService, IBrowserPort],
})
export class BrowserModule {}
