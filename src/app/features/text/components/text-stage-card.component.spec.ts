import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TextStageCardComponent', () => {
  it('折叠列表模板应保留 inert 与 aria-hidden 防线', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('[attr.inert]="!isExpanded() ? \'\' : null"');
    expect(source).toContain('[attr.aria-hidden]="!isExpanded()"');
  });

  it('阶段任务列表应保留内层滚动并启用平滑交接', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('overflow-y-auto');
    expect(source).toContain('max-h-[60vh]');
    expect(source).toContain('max-h-[40vh]');
    expect(source).toContain('(wheel)="onTaskListWheel($event)"');
    expect(source).toContain('(touchmove)="onTaskListTouchMove($event)"');
    expect(source).toContain('NESTED_SCROLL_EDGE_THRESHOLD_PX');
    expect(source).toContain('NESTED_SCROLL_MAX_OUTER_SHARE');
  });
});
