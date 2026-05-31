import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TextStageCardComponent', () => {
  it('折叠列表模板应保留 inert 与 aria-hidden 防线', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('[attr.inert]="!isExpanded() ? \'\' : null"');
    expect(source).toContain('[attr.aria-hidden]="!isExpanded()"');
  });

  it('阶段任务列表应交给外层阶段容器统一滚动', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('max-h-none overflow-visible');
    expect(source).not.toContain('overflow-y-auto');
    expect(source).not.toContain('max-h-[60vh]');
    expect(source).not.toContain('max-h-[40vh]');
    expect(source).not.toContain('[style.overscroll-behavior-y]');
  });
});
