/**
 * Content Enhancements module — P1, P5, P6, P9, P10 utilities.
 *
 * Provides services that augment the generation pipeline:
 *   - ContentPillarTracker (P6) — Redis-backed 7-day pillar rotation
 *
 * Pure utility functions (P9 bait detector, P10 source URL, P5 trend guardrail)
 * are exported as standalone functions and do not need module registration —
 * they are imported directly where needed.
 *
 * The HookPerformanceBank (P1) is also registered here when analytics data
 * is available.
 */
import { Module } from "@nestjs/common";
import { ContentPillarTracker } from "./content-pillar.tracker.js";
import { HookPerformanceBank } from "./hook-performance-bank.js";
import { VisualConceptService } from "./visual-concept.service.js";
import { ThreadDepthService } from "./thread-depth.service.js";
import { ABVariantGenerator } from "./ab-variant.generator.js";
import { ABVariantService } from "./ab-variant.service.js";

@Module({
  providers: [
    ContentPillarTracker,
    HookPerformanceBank,
    VisualConceptService,
    ThreadDepthService,
    ABVariantGenerator,
    ABVariantService,
  ],
  exports: [
    ContentPillarTracker,
    HookPerformanceBank,
    VisualConceptService,
    ThreadDepthService,
    ABVariantGenerator,
    ABVariantService,
  ],
})
export class ContentEnhancementsModule {}
