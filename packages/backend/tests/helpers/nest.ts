/**
 * NestJS Testing Helpers — utilities for creating testing modules.
 *
 * Usage in unit tests:
 *   const module = await createTestingModule({
 *     providers: [
 *       GenerationService,
 *       { provide: ILlmPort, useValue: createMockLlmPort() },
 *       ...
 *     ],
 *   });
 *   const service = module.get(GenerationService);
 */

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';

export interface TestModuleOptions {
  providers?: Provider[];
  imports?: unknown[];
  controllers?: Type<unknown>[];
}

export async function createTestingModule(
  options: TestModuleOptions,
): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: options.imports ?? [],
    providers: options.providers ?? [],
    controllers: options.controllers ?? [],
  });

  return builder.compile();
}

/**
 * Create a testing module with a controller and its mocked providers.
 * Returns both the controller instance and the module for cleanup.
 */
export async function createControllerTestingModule<T>(
  controller: Type<T>,
  providers: Provider[],
): Promise<{ controller: T; module: TestingModule }> {
  const module = await createTestingModule({
    controllers: [controller],
    providers,
  });
  const ctrl = module.get(controller);
  return { controller: ctrl, module };
}
