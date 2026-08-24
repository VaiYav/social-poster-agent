import { describe, it, expect } from "vitest";
import {
  extractFactsFromMarkdown,
  normalizeFact,
} from "../../../src/infrastructure/content/extract-facts.js";

describe("extractFactsFromMarkdown (F10)", () => {
  it("F10-001: extracts bullet list items as facts", () => {
    const md = `
# Remote Work in Q1

Workflow enters Q1 every two years and stays for about six weeks.

- Remote Work in Q1 happens every 2 years
- Q1 Workflow = impulsive action, conflict-ready
- Workflow stays in Q1 ~6 weeks
`;
    const facts = extractFactsFromMarkdown(md, {}, "Remote Work in Q1");

    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(facts).toContain("Remote Work in Q1 happens every 2 years");
    expect(facts).toContain("Q1 Workflow = impulsive action, conflict-ready");
    expect(facts).toContain("Workflow stays in Q1 ~6 weeks");
  });

  it("F10-002: extracts H2/H3 headings as facts", () => {
    const md = `
## Remote Work in Q1 affects target segments most
### Good time to start projects
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain("Remote Work in Q1 affects target segments most");
    expect(facts).toContain("Good time to start projects");
  });

  it("F10-003: extracts bold phrases as facts", () => {
    const md = `
The **Workflow-Q1 cycle repeats roughly every 2 years**, which is a key rhythm in predictive productivity.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain("Workflow-Q1 cycle repeats roughly every 2 years");
  });

  it("F10-004: includes frontmatter keyPoints and answer with short fact support", () => {
    const frontmatter = {
      answerCapsule: {
        question: "What does the product launch in Q4 mean?",
        answer: "Focus on goals and structure.",
        keyPoints: ["Goal-setting", "Discipline"],
      },
      description: "Discipline and ambition under the product launch.",
    };
    const facts = extractFactsFromMarkdown("", frontmatter, "Product Launch in Q4");

    expect(facts).toContain("Goal-setting");
    expect(facts).toContain("Discipline");
    expect(facts).toContain("Focus on goals and structure.");
    // description is skipped when answerCapsule is present
    expect(facts).not.toContain("Discipline and ambition under the product launch.");
  });

  it("F10-005: falls back to description when answerCapsule is missing", () => {
    const frontmatter = {
      description: "Remote Work in Q1 is a high-energy period for starting new ventures.",
    };
    const facts = extractFactsFromMarkdown("", frontmatter, "Remote Work in Q1");

    expect(facts).toEqual(["Remote Work in Q1 is a high-energy period for starting new ventures."]);
  });

  it("F10-006: falls back to title when no other facts exist", () => {
    const facts = extractFactsFromMarkdown("", {}, "Customer Feedback Enters Q2");

    expect(facts).toEqual(["Customer Feedback Enters Q2"]);
  });

  it("F10-007: deduplicates near-identical facts", () => {
    const md = `
- Remote Work in Q1 happens every 2 years
- remote work in q1 happens every 2 years
- **Remote Work in Q1 happens every 2 years**
`;
    const facts = extractFactsFromMarkdown(md, {}, "Remote Work in Q1");

    expect(
      facts.filter((f) => f.toLowerCase().includes("remote work in q1 happens every 2 years")),
    ).toHaveLength(1);
  });

  it("F10-008: filters out very short or markup-only fragments", () => {
    const md = `
- ok
- **Workflow** is a planet
- 1. A
`;
    const facts = extractFactsFromMarkdown(md, {}, "Workflow");

    expect(facts).not.toContain("ok");
    expect(facts).not.toContain("A");
    // "Workflow is a planet" should survive because body minLength is 20
    expect(facts).toContain("Workflow is a planet");
  });

  it("F10-009: truncates overly long facts at sentence boundary", () => {
    const longSentence =
      "This is a deliberately long productivity fact that contains many words and should be truncated near the boundary so that it fits within the social post size limits and remains useful for generation. " +
      "It also has a second sentence that should not appear after truncation.";
    const facts = extractFactsFromMarkdown(`- ${longSentence}`, {});

    expect(facts[0]!.length).toBeLessThanOrEqual(244); // 240 + punctuation overhead safety
    expect(facts[0]!.endsWith(".")).toBe(true);
    expect(facts[0]!).not.toContain("second sentence");
  });

  it("F10-010: respects maxFacts option", () => {
    const md = `
- The first fact about Remote Work in Q1
- The second fact about Q1 energy
- The third fact about target segments
- The fourth fact about six weeks
- The fifth fact about starting projects
`;
    const facts = extractFactsFromMarkdown(md, {}, "Title", { maxFacts: 3 });

    expect(facts).toHaveLength(3);
  });

  it("F10-011: extracts first sentence of paragraphs under headings", () => {
    const md = `
## Target segments feel this most intensely
Target segments, including Q1, Q2 and Q3, experience the workflow surge as a surge of initiative. They often act first and reflect later during this six-week window.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain(
      "Target segments, including Q1, Q2 and Q3, experience the workflow surge as a surge of initiative.",
    );
  });

  it("F10-012: strips markdown links and images from extracted facts", () => {
    const md = `
- Read more about [workflow slowdown](/workflow-slowdown) in our guide.
- ![workflow tool](workflow.jpg) is the main driver of Q1.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain("Read more about workflow slowdown in our guide.");
    expect(facts).toContain("workflow tool is the main driver of Q1.");
  });
});

describe("normalizeFact", () => {
  it("returns null for very short strings", () => {
    expect(normalizeFact("ok")).toBeNull();
  });

  it("removes markdown syntax", () => {
    expect(normalizeFact("**bold** and _italic_ and `code`")).toBe("bold and italic and code");
  });

  it("removes markdown links but keeps text", () => {
    expect(normalizeFact("[Workflow is the red planet](https://example.com/workflow)")).toBe(
      "Workflow is the red planet",
    );
  });
});
