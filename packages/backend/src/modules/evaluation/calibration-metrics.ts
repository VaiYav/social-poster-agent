export interface BinaryCalibrationPair {
  judgePass: boolean;
  humanPass: boolean;
}

export interface BinaryCalibrationMetrics {
  samples: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  tpr: number | null;
  tnr: number | null;
  kappa: number | null;
}

/** Compute bounded binary judge-vs-human calibration metrics. */
export function computeBinaryCalibration(
  pairs: readonly BinaryCalibrationPair[],
): BinaryCalibrationMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (const pair of pairs) {
    if (pair.judgePass && pair.humanPass) truePositive++;
    else if (pair.judgePass && !pair.humanPass) falsePositive++;
    else if (!pair.judgePass && pair.humanPass) falseNegative++;
    else trueNegative++;
  }

  const samples = pairs.length;
  const actualPositive = truePositive + falseNegative;
  const actualNegative = trueNegative + falsePositive;
  const judgePositive = truePositive + falsePositive;
  const judgeNegative = trueNegative + falseNegative;
  const accuracy = ratio(truePositive + trueNegative, samples);
  const precision = ratio(truePositive, judgePositive);
  const recall = ratio(truePositive, actualPositive);
  const tnr = ratio(trueNegative, actualNegative);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  let kappa: number | null = null;
  if (samples > 0) {
    const observed = (truePositive + trueNegative) / samples;
    const expected =
      (actualPositive * judgePositive + actualNegative * judgeNegative) / (samples * samples);
    kappa = expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
  }

  return {
    samples,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    accuracy,
    precision,
    recall,
    f1,
    tpr: recall,
    tnr,
    kappa,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
