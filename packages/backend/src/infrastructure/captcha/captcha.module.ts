/**
 * Sprint O: Captcha Module — provides CaptchaSolverService.
 */
import { Module } from "@nestjs/common";
import { CaptchaSolverService } from "./captcha-solver.service.js";

@Module({
  providers: [CaptchaSolverService],
  exports: [CaptchaSolverService],
})
export class CaptchaModule {}
