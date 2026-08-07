import { describe, it, expect } from 'vitest';
import { extractFactsFromMarkdown, normalizeFact } from '../../../src/infrastructure/content/extract-facts.js';

describe('extractFactsFromMarkdown (F10)', () => {
  it('F10-001: extracts bullet list items as facts', () => {
    const md = `
# Mars in Aries

Mars enters Aries every two years and stays for about six weeks.

- Mars in Aries happens every 2 years
- Aries Mars = impulsive action, conflict-ready
- Mars stays in Aries ~6 weeks
`;
    const facts = extractFactsFromMarkdown(md, {}, 'Mars in Aries');

    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(facts).toContain('Mars in Aries happens every 2 years');
    expect(facts).toContain('Aries Mars = impulsive action, conflict-ready');
    expect(facts).toContain('Mars stays in Aries ~6 weeks');
  });

  it('F10-002: extracts H2/H3 headings as facts', () => {
    const md = `
## Mars in Aries affects fire signs most
### Good time to start projects
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain('Mars in Aries affects fire signs most');
    expect(facts).toContain('Good time to start projects');
  });

  it('F10-003: extracts bold phrases as facts', () => {
    const md = `
The **Mars-Aries cycle repeats roughly every 2 years**, which is a key rhythm in predictive astrology.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain('Mars-Aries cycle repeats roughly every 2 years');
  });

  it('F10-004: includes frontmatter keyPoints and answer with short fact support', () => {
    const frontmatter = {
      answerCapsule: {
        question: 'What does the full moon in Capricorn mean?',
        answer: 'Focus on goals and structure.',
        keyPoints: ['Goal-setting', 'Discipline'],
      },
      description: 'Discipline and ambition under the full moon.',
    };
    const facts = extractFactsFromMarkdown('', frontmatter, 'Full Moon in Capricorn');

    expect(facts).toContain('Goal-setting');
    expect(facts).toContain('Discipline');
    expect(facts).toContain('Focus on goals and structure.');
    // description is skipped when answerCapsule is present
    expect(facts).not.toContain('Discipline and ambition under the full moon.');
  });

  it('F10-005: falls back to description when answerCapsule is missing', () => {
    const frontmatter = { description: 'Mars in Aries is a high-energy transit for starting new ventures.' };
    const facts = extractFactsFromMarkdown('', frontmatter, 'Mars in Aries');

    expect(facts).toEqual(['Mars in Aries is a high-energy transit for starting new ventures.']);
  });

  it('F10-006: falls back to title when no other facts exist', () => {
    const facts = extractFactsFromMarkdown('', {}, 'Venus Enters Leo');

    expect(facts).toEqual(['Venus Enters Leo']);
  });

  it('F10-007: deduplicates near-identical facts', () => {
    const md = `
- Mars in Aries happens every 2 years
- mars in aries happens every 2 years
- **Mars in Aries happens every 2 years**
`;
    const facts = extractFactsFromMarkdown(md, {}, 'Mars in Aries');

    expect(facts.filter((f) => f.toLowerCase().includes('mars in aries happens every 2 years'))).toHaveLength(1);
  });

  it('F10-008: filters out very short or markup-only fragments', () => {
    const md = `
- ok
- **Mars** is a planet
- 1. A
`;
    const facts = extractFactsFromMarkdown(md, {}, 'Mars');

    expect(facts).not.toContain('ok');
    expect(facts).not.toContain('A');
    // "Mars is a planet" should survive because body minLength is 20
    expect(facts).toContain('Mars is a planet');
  });

  it('F10-009: truncates overly long facts at sentence boundary', () => {
    const longSentence =
      'This is a deliberately long astrology fact that contains many words and should be truncated near the boundary so that it fits within the social post size limits and remains useful for generation. ' +
      'It also has a second sentence that should not appear after truncation.';
    const facts = extractFactsFromMarkdown(`- ${longSentence}`, {});

    expect(facts[0]!.length).toBeLessThanOrEqual(244); // 240 + punctuation overhead safety
    expect(facts[0]!.endsWith('.')).toBe(true);
    expect(facts[0]!).not.toContain('second sentence');
  });

  it('F10-010: respects maxFacts option', () => {
    const md = `
- The first fact about Mars in Aries
- The second fact about Aries energy
- The third fact about fire signs
- The fourth fact about six weeks
- The fifth fact about starting projects
`;
    const facts = extractFactsFromMarkdown(md, {}, 'Title', { maxFacts: 3 });

    expect(facts).toHaveLength(3);
  });

  it('F10-011: extracts first sentence of paragraphs under headings', () => {
    const md = `
## Fire signs feel this most intensely
Fire signs, including Aries, Leo and Sagittarius, experience the Mars transit as a surge of initiative. They often act first and reflect later during this six-week window.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain('Fire signs, including Aries, Leo and Sagittarius, experience the Mars transit as a surge of initiative.');
  });

  it('F10-012: strips markdown links and images from extracted facts', () => {
    const md = `
- Read more about [Mars retrograde](/mars-retrograde) in our guide.
- ![Mars planet](mars.jpg) is the ruling planet of Aries.
`;
    const facts = extractFactsFromMarkdown(md);

    expect(facts).toContain('Read more about Mars retrograde in our guide.');
    expect(facts).toContain('Mars planet is the ruling planet of Aries.');
  });
});

describe('normalizeFact', () => {
  it('returns null for very short strings', () => {
    expect(normalizeFact('ok')).toBeNull();
  });

  it('removes markdown syntax', () => {
    expect(normalizeFact('**bold** and _italic_ and `code`')).toBe('bold and italic and code');
  });

  it('removes markdown links but keeps text', () => {
    expect(normalizeFact('[Mars is the red planet](https://example.com/mars)')).toBe('Mars is the red planet');
  });
});
