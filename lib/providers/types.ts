/**
 * The provider contract. Both adapters (anthropic, gemini) implement this one
 * interface, so the route and the reliability layer never care which provider
 * is behind it. Swapping or adding a provider later touches only its adapter.
 */
import type { Provider } from '../types';

/** Everything a provider needs to translate one page. */
export interface PageInput {
  imageBase64: string;
  pageNum: number;
  apiKey: string;
  model: string;
}

/** What every provider returns: the raw model text + whether it was cut off. */
export interface RawResult {
  text: string;
  /** true when the model hit its output-token ceiling (finishReason MAX_TOKENS). */
  truncated: boolean;
}

export interface TranslationProvider {
  readonly name: Provider;
  translate(input: PageInput): Promise<RawResult>;
}
