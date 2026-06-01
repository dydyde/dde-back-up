import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('flow-link-template.service.ts', () => {
  it('应让移动端关联块保持无直接 click 处理并扩大触控热区', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-link-template.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('// 桌面端保留标签点击直达编辑；移动端交由 ObjectSingleClicked 统一处理');
    expect(source).toContain('...(isMobile ? {} : {');
    expect(source).toContain('minSize: new go.Size(44, 24)');
  });

  it('应在 LinkingTool 结束后清空临时起点端口状态，避免下一次拉线串用旧 source', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-link-template.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('const pointerPort = findEdgePortAtPointer(this);');
    expect(source).toContain('toolExt.startPort = null;');
    expect(source).toContain('toolExt.fromPort = null;');
    expect(source).toContain('toolExt.originalFromPort = null;');
  });

  it('应绑定连接线 points 和稳定曲率，避免模型刷新后重新选择路径', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-link-template.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('adjusting: go.Link.End');
    expect(source).toContain('new go.Binding("curviness", "curviness")');
    expect(source).toContain('new go.Binding("points").makeTwoWay()');
  });
});
