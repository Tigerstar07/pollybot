import type { ProbabilityEstimate } from "../types";
import { clamp } from "../utils";

export function applyLlmReview(
  base: ProbabilityEstimate,
  review: ProbabilityEstimate | undefined,
): ProbabilityEstimate {
  if (!review) return base;
  const disagreement = Math.abs(base.estimatedYesProbability - review.estimatedYesProbability);
  const materialDisagreement = disagreement > 0.15;
  return {
    ...base,
    confidence: Math.min(base.confidence, review.confidence),
    method: `${base.method}+llm-review`,
    reasoningSummary: `${base.reasoningSummary} Model review: ${review.reasoningSummary}`,
    keyEvidence: base.keyEvidence,
    risks: [
      ...new Set([
        ...base.risks,
        ...review.risks.map((risk) => `Model review: ${risk}`),
        ...(materialDisagreement
          ? [`Model review disagreed by ${(disagreement * 100).toFixed(1)} percentage points`]
          : []),
      ]),
    ],
    modelUncertainty: clamp(Math.max(base.modelUncertainty, review.modelUncertainty, disagreement), 0.02, 0.5),
    shouldSkip: base.shouldSkip || review.shouldSkip || materialDisagreement,
  };
}
