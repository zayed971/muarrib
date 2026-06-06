export type BlockType =
  | 'heading'
  | 'subheading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'caption'
  | 'figure'
  | 'equation'
  | 'code';

export type TableCell = { ar: string; en?: string } | string;

export interface Block {
  type: BlockType;
  ar?: string;
  en?: string;
  items?: string[];
  rows?: TableCell[][];
  content?: string;
  lowconf?: boolean;
}

export type Provider = 'anthropic' | 'gemini';

export interface TranslatePageRequest {
  imageBase64: string;
  pageNum: number;
  provider: Provider;
}

export interface TranslatePageResponse {
  blocks?: Block[];
  error?: string;
}
