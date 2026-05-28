import { describe, expect, it } from 'vitest';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { kramdownToPlainText, normalizePreview } from './siyuan-preview-utils';

describe('siyuan-preview-utils', () => {
  it('converts Kramdown to conservative plain text', () => {
    expect(kramdownToPlainText('## 标题 {: id="x"}\n((20260426123456-abc1234 "引用")) ![图](assets/a.png)')).toContain('标题 引用 图片');
  });

  it('truncates previews and direct child blocks by configured limits', () => {
    const preview = normalizePreview({
      blockId: '20260426123456-abc1234',
      title: '细菌能量来源',
      kramdown: 'x'.repeat(SIYUAN_CONFIG.MAX_PREVIEW_CHARS + 20),
      childBlocks: Array.from({ length: SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN + 2 }, (_, index) => ({
        id: `2026042612345${index % 10}-abc1234`,
        content: `child ${index}`,
        type: 'p',
      })),
    });

    expect(preview.truncated).toBe(true);
    expect(preview.title).toBe('细菌能量来源');
    expect(preview.excerpt?.length).toBeLessThanOrEqual(SIYUAN_CONFIG.MAX_PREVIEW_CHARS + 1);
    expect(preview.childBlocks).toHaveLength(SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN);
  });
});
