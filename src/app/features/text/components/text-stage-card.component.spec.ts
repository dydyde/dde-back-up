import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TextStageCardComponent', () => {
  it('折叠列表模板应保留 inert 与 aria-hidden 防线', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('[attr.inert]="!isExpanded() ? \'\' : null"');
    expect(source).toContain('[attr.aria-hidden]="!isExpanded()"');
  });

  it('阶段任务列表应保留原生内外滚动链路', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('overflow-y-auto');
    expect(source).toContain('max-h-[60vh]');
    expect(source).toContain('max-h-[40vh]');
    expect(source).toContain('overscroll-behavior-y: auto');
    expect(source).toContain('-webkit-overflow-scrolling: touch');
    expect(source).toContain('scrollbar-gutter: stable');
    expect(source).not.toContain('(wheel)=');
    expect(source).not.toContain('(touchmove)=');
    expect(source).not.toContain('onTaskListWheel');
    expect(source).not.toContain('onTaskListTouchMove');
    expect(source).not.toContain('scrollTop =');
  });
});
