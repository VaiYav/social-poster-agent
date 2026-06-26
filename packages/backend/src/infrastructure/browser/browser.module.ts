import { Module } from '@nestjs/common';
import { BrowserFactory } from './browser.factory';
import { IBrowserPort } from '../../domain/ports/browser.port.js';

@Module({
  providers: [
    BrowserFactory,
    { provide: IBrowserPort, useExisting: BrowserFactory },
  ],
  exports: [BrowserFactory, IBrowserPort],
})
export class BrowserModule {}
