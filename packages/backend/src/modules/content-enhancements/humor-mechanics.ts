/**
 * Q5: Humor Mechanics layer — operationalizes humor instead of "be funny".
 *
 * Research grounding (HumorGen arXiv 2604.09629, HumorPlanSearch arXiv
 * 2508.11429, DeepMind arXiv 2405.20956): winning jokes are dominated by
 * incongruity/absurdity (>84%), punchline-last positioning (96%) and
 * conciseness (72%); losing jokes by generic punchlines (69%), cliché (65%)
 * and over-explanation (22%). Vague "be funny" instructions produce the
 * predictable slop; explicit MECHANICS produce jokes.
 *
 * One mechanic is rotated per post (deterministic, seeded like content
 * styles but with a different offset so style×mechanic combos vary).
 * Serious/poetic content styles skip the humor layer entirely.
 */

import { SocialNetwork } from "../../generated/prisma/client.js";

export interface HumorMechanic {
  id: string;
  name: string;
  guidance: string;
}

export const HUMOR_MECHANICS: HumorMechanic[] = [
  {
    id: "misdirection",
    name: "Misdirection",
    guidance:
      "Setup builds one expectation, the last line breaks it. The punchline is the FINAL line — never explain the joke after landing it.",
  },
  {
    id: "understatement",
    name: "Understatement",
    guidance:
      'Describe something dramatic or significant in deliberately flat, mundane terms. ("A major rebrand. Anyway, I fixed a typo.")',
  },
  {
    id: "hyperbole_deadpan",
    name: "Deadpan hyperbole",
    guidance:
      "Absurd exaggeration delivered with total seriousness. No exclamation marks. The flatter the delivery, the funnier the absurdity.",
  },
  {
    id: "self_deprecation",
    name: "Self-deprecation",
    guidance:
      "The narrator is the punchline. Their own habits called them out and they know it. Punch at yourself, never at the reader.",
  },
  {
    id: "absurd_specificity",
    name: "Absurd specificity",
    guidance:
      'One detail so oddly specific it becomes funny. Not "cried" but "cried into a reusable grocery bag". Specificity IS the joke.',
  },
  {
    id: "meta_irony",
    name: "Meta-irony",
    guidance:
      "Acknowledge you are a brand account doing brand-account things, wink at it, move on. Self-aware but not self-loathing.",
  },
  {
    id: "irony",
    name: "Irony",
    guidance:
      "Frame an outcome as if it were the plan all along when it obviously was not, or say the opposite of what actually happened. Let the gap between words and reality do the work — do not point it out.",
  },
  {
    id: "post_irony",
    name: "Post-irony",
    guidance:
      "Deliver something absurd or oddly vulnerable completely straight — no wink, no twist, no tell. It should be genuinely unclear whether you mean it. The ambiguity is the joke, not a reveal at the end.",
  },
  {
    id: "sarcasm",
    name: "Sarcasm",
    guidance:
      'Say the opposite of what you mean, dripping with obvious insincerity — aimed at the situation or the narrator\'s own choices, never at the reader. ("Sure, deadline, great timing, love this for me.")',
  },
];

/** Shared safety + delivery rules appended whenever a mechanic is injected. */
export const HUMOR_RULES = [
  "The joke lives in ONE line. If you explain it, delete the explanation.",
  "If the punchline is not the last line, move it there.",
  "Punch at situations, systems, and the narrator — NEVER at people or groups.",
  "If the joke does not land naturally, write the post straight instead of forcing it.",
].join("\n- ");

export const HUMOR_MECHANICS_BY_ID: Record<string, HumorMechanic> = Object.fromEntries(
  HUMOR_MECHANICS.map((m) => [m.id, m]),
);

/**
 * Pick a humor mechanic for a run — deterministic date+network+seed rotation,
 * offset from the content-style rotation (×7, +3) so the style×mechanic
 * pairing changes day to day instead of moving in lockstep.
 */
export function pickHumorMechanic(network: SocialNetwork, seed?: string): HumorMechanic {
  const now = new Date();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000,
  );

  let extraEntropy = 0;
  if (seed) {
    for (let i = 0; i < seed.length; i++) {
      extraEntropy = (extraEntropy + seed.charCodeAt(i) * 7) % 1000;
    }
  }

  const networkHash = network === SocialNetwork.X ? 0 : network === SocialNetwork.THREADS ? 1 : 2;
  const index = (dayOfYear * 7 + networkHash * 3 + extraEntropy) % HUMOR_MECHANICS.length;

  return HUMOR_MECHANICS[index] ?? HUMOR_MECHANICS[0]!;
}

/**
 * Render the mechanic block for the draft system prompt.
 * Returns '' when the content style is not humor-compatible.
 */
export function getHumorPromptGuidance(mechanic: HumorMechanic | null): string {
  if (!mechanic) return "";
  return `\n\nHUMOR MECHANIC for this post — "${mechanic.name}":\n${mechanic.guidance}\nRULES:\n- ${HUMOR_RULES}\n`;
}
