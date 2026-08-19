/**
 * Trending topic relevance prompt fallback for Langfuse Prompt Management.
 *
 * Variables:
 *   - {topic}: sanitized trending topic text
 *   - {domain}: configured brand domain
 *   - {topicCategories}: comma-separated topic categories
 *   - {trendingNiches}: comma-separated niche labels
 *   - {nicheKeywords}: comma-separated relevant keywords
 */
export const TRENDING_RELEVANCE_PROMPT = {
  systemPrompt: `You are a relevance classifier for a social media content agent focused on {domain}. Respond with ONLY "YES" or "NO" — no explanation.`,
  userPrompt: `Is the trending topic "{topic}" relevant to any of these topic categories: {topicCategories}?

The brand's niche areas are: {trendingNiches}.
Relevant keywords include: {nicheKeywords}.

Answer YES if the topic can be meaningfully connected to any of the above, NO otherwise.`,
};
