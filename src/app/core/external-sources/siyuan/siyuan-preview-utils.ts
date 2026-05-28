import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';

const KRAMDOWN_ATTR_PATTERN = /\{:\s*[^}]+\}/g;
const BLOCK_REF_PATTERN = /\(\(([0-9]{14}-[a-z0-9]{7})(?:\s+"([^"]*)")?\)\)/gi;
const MARKDOWN_MARK_PATTERN = /[`*_>#\-\[\]()]/g;

export function kramdownToPlainText(kramdown: string): string {
  return kramdown
    // 移除思源块属性尾标记。
    .replace(KRAMDOWN_ATTR_PATTERN, '')
    // 块引用仅保留显示文本或 blockId，避免首版产生块内漫游入口。
    .replace(BLOCK_REF_PATTERN, (_match, blockId: string, label?: string) => label || blockId)
    // 资源文件首版不代理加载，只保留占位文本。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    // 普通 Markdown 链接保留可读文本，不直接注入 HTML。
    .replace(/\[[^\]]+\]\([^)]*\)/g, text => text.replace(/^\[|\]\([^)]*\)$/g, ''))
    // 删除剩余 Markdown 标记，输出安全摘要文本。
    .replace(MARKDOWN_MARK_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildExcerpt(text: string): { excerpt: string; truncated: boolean } {
  if (text.length <= SIYUAN_CONFIG.MAX_PREVIEW_CHARS) return { excerpt: text, truncated: false };
  return { excerpt: `${text.slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHARS).trim()}…`, truncated: true };
}

export function normalizeChildBlocks(children: SiyuanChildBlockPreview[]): { children: SiyuanChildBlockPreview[]; truncated: boolean } {
  const normalized = children.slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN).map(child => ({
    id: child.id,
    type: child.type,
    content: kramdownToPlainText(child.content).slice(0, 240),
  }));
  return { children: normalized, truncated: children.length > SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN };
}

export function normalizePreview(input: Omit<SiyuanBlockPreview, 'excerpt' | 'truncated'> & { truncated?: boolean }): SiyuanBlockPreview {
  const plainText = input.plainText ?? kramdownToPlainText(input.kramdown ?? '');
  const excerpt = buildExcerpt(plainText);
  const childBlocks = input.childBlocks ? normalizeChildBlocks(input.childBlocks) : { children: [], truncated: false };
  return {
    blockId: input.blockId,
    title: input.title,
    hpath: input.hpath,
    plainText: excerpt.excerpt,
    excerpt: excerpt.excerpt,
    sourceUpdatedAt: input.sourceUpdatedAt,
    childBlocks: childBlocks.children,
    truncated: Boolean(input.truncated || excerpt.truncated || childBlocks.truncated),
  };
}

export function mapSiyuanError(error: unknown): SiyuanPreviewErrorCode {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('401') || message.includes('403') || message.includes('token')) return 'token-invalid';
    if (message.includes('not found') || message.includes('不存在')) return 'block-not-found';
    if (message.includes('abort')) return 'unknown';
    if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) return 'kernel-unreachable';
  }
  return 'unknown';
}
