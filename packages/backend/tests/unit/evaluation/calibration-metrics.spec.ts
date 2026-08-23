import { describe, expect, it } from "vitest";
import { computeBinaryCalibration } from "../../../src/modules/evaluation/calibration-metrics.js";

describe("EVAL-505 calibration metrics", () => {
  it("computes confusion matrix, rates and Cohen kappa", () => {
    const metrics = computeBinaryCalibration([
      { judgePass: true, humanPass: true },
      { judgePass: true, humanPass: false },
      { judgePass: false, humanPass: true },
      { judgePass: false, humanPass: false },
    ]);

    expect(metrics).toMatchObject({
      samples: 4,
      truePositive: 1,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
      accuracy: 0.5,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      tpr: 0.5,
      tnr: 0.5,
      kappa: 0,
    });
  });

  it("returns explicit nulls for empty evidence", () => {
    expect(computeBinaryCalibration([])).toEqual({
      samples: 0,
      truePositive: 0,
      falsePositive: 0,
      trueNegative: 0,
      falseNegative: 0,
      accuracy: null,
      precision: null,
      recall: null,
      f1: null,
      tpr: null,
      tnr: null,
      kappa: null,
    });
  });

  it("handles a perfect single-class agreement without NaN", () => {
    const metrics = computeBinaryCalibration([
      { judgePass: true, humanPass: true },
      { judgePass: true, humanPass: true },
    ]);
    expect(metrics.accuracy).toBe(1);
    expect(metrics.kappa).toBe(1);
    expect(metrics.tnr).toBeNull();
  });
});
