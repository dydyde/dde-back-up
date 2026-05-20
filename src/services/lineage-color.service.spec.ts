import { describe, it, expect, beforeEach } from 'vitest';
import { LineageColorService } from './lineage-color.service';
import { Task } from '../models';

/**
 * 构建最小化 Task 对象用于测试
 */
function makeTask(id: string, parentId: string | null = null): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: id,
  } as Task;
}

/**
 * 构建最小化 GoJSNodeData
 */
function makeNode(key: string) {
  return { key, text: key } as any;
}

/**
 * 构建最小化 GoJSLinkData
 */
function makeLink(from: string, to: string) {
  return { from, to } as any;
}

describe('LineageColorService', () => {
  let service: LineageColorService;

  beforeEach(() => {
    service = new LineageColorService();
  });

  describe('颜色确定性', () => {
    it('不同任务加载顺序应产生相同的颜色映射', () => {
      // 三棵独立的树
      const treeA_root = makeTask('aaa-root');
      const treeA_child = makeTask('aaa-child', 'aaa-root');
      const treeB_root = makeTask('bbb-root');
      const treeC_root = makeTask('ccc-root');
      const treeC_child = makeTask('ccc-child', 'ccc-root');

      // 顺序 1：A -> B -> C
      const order1 = [treeA_root, treeA_child, treeB_root, treeC_root, treeC_child];
      const nodes1 = order1.map(t => makeNode(t.id));
      const result1 = service.preprocessDiagramData(nodes1, [], order1);

      // 顺序 2：C -> B -> A（反序）
      const order2 = [treeC_child, treeC_root, treeB_root, treeA_child, treeA_root];
      const nodes2 = order2.map(t => makeNode(t.id));
      const result2 = service.preprocessDiagramData(nodes2, [], order2);

      // 顺序 3：B -> C -> A（乱序）
      const order3 = [treeB_root, treeC_root, treeA_root, treeC_child, treeA_child];
      const nodes3 = order3.map(t => makeNode(t.id));
      const result3 = service.preprocessDiagramData(nodes3, [], order3);

      // 提取每个节点的颜色映射 (nodeId -> familyColor)
      const colorMap1 = new Map(result1.nodeDataArray.map(n => [n.key, n.familyColor]));
      const colorMap2 = new Map(result2.nodeDataArray.map(n => [n.key, n.familyColor]));
      const colorMap3 = new Map(result3.nodeDataArray.map(n => [n.key, n.familyColor]));

      // 所有顺序的颜色映射应完全一致
      for (const nodeId of ['aaa-root', 'aaa-child', 'bbb-root', 'ccc-root', 'ccc-child']) {
        expect(colorMap1.get(nodeId)).toBe(colorMap2.get(nodeId));
        expect(colorMap2.get(nodeId)).toBe(colorMap3.get(nodeId));
      }
    });

    it('同一棵树的所有节点应共享相同颜色', () => {
      const root = makeTask('root');
      const child1 = makeTask('child-1', 'root');
      const child2 = makeTask('child-2', 'root');
      const grandchild = makeTask('grandchild', 'child-1');

      const tasks = [root, child1, child2, grandchild];
      const nodes = tasks.map(t => makeNode(t.id));
      const result = service.preprocessDiagramData(nodes, [], tasks);

      const colors = result.nodeDataArray.map(n => n.familyColor);
      expect(new Set(colors).size).toBe(1);
    });

    it('不同树应获得不同颜色', () => {
      const tree1 = makeTask('tree-1');
      const tree2 = makeTask('tree-2');

      const tasks = [tree1, tree2];
      const nodes = tasks.map(t => makeNode(t.id));
      const result = service.preprocessDiagramData(nodes, [], tasks);

      expect(result.nodeDataArray[0].familyColor).not.toBe(result.nodeDataArray[1].familyColor);
    });

    it('连线应继承源节点的家族颜色', () => {
      const root = makeTask('root');
      const child = makeTask('child', 'root');

      const tasks = [root, child];
      const nodes = tasks.map(t => makeNode(t.id));
      const links = [makeLink('root', 'child')];
      const result = service.preprocessDiagramData(nodes, links, tasks);

      const rootColor = result.nodeDataArray.find(n => n.key === 'root')!.familyColor;
      expect(result.linkDataArray[0].familyColor).toBe(rootColor);
    });

    it('分配待分配块后，既有任务树颜色不应因根集合变化而重排', () => {
      const assignedRoot = { ...makeTask('m-root'), stage: 1 };
      const assignedChild = { ...makeTask('m-child', 'm-root'), stage: 2 };
      const unassignedRoot = makeTask('a-pending');
      const unassignedChild = makeTask('a-pending-child', 'a-pending');

      const beforeTasks = [unassignedRoot, unassignedChild, assignedRoot, assignedChild];
      const beforeNodes = beforeTasks.map(t => makeNode(t.id));
      const beforeLinks = [makeLink('m-root', 'm-child')];
      const before = service.preprocessDiagramData(beforeNodes, beforeLinks, beforeTasks);

      const afterPendingRoot = { ...unassignedRoot, parentId: 'm-root', stage: 2 };
      const afterPendingChild = { ...unassignedChild, stage: 3 };
      const afterTasks = [assignedRoot, assignedChild, afterPendingRoot, afterPendingChild];
      const afterNodes = afterTasks.map(t => makeNode(t.id));
      const afterLinks = [
        makeLink('m-root', 'm-child'),
        makeLink('m-root', 'a-pending'),
        makeLink('a-pending', 'a-pending-child'),
      ];
      const after = service.preprocessDiagramData(afterNodes, afterLinks, afterTasks);

      const beforeColors = new Map(before.nodeDataArray.map(node => [node.key, node.familyColor]));
      const afterColors = new Map(after.nodeDataArray.map(node => [node.key, node.familyColor]));
      const beforeAssignedLinkColor = before.linkDataArray.find(link => link.from === 'm-root')!.familyColor;
      const afterAssignedLinkColor = after.linkDataArray.find(link => link.to === 'm-child')!.familyColor;

      expect(afterColors.get('m-root')).toBe(beforeColors.get('m-root'));
      expect(afterColors.get('m-child')).toBe(beforeColors.get('m-child'));
      expect(afterAssignedLinkColor).toBe(beforeAssignedLinkColor);
      expect(afterColors.get('a-pending')).toBe(afterColors.get('m-root'));
    });

    it('应能将 HEX 调色板颜色压暗用于细节提示', () => {
      expect(service.getDarkerFamilyColor('#e63946')).toBe('#bd2f39');
    });

    it('应能将 HEX 调色板颜色提亮用于高亮提示', () => {
      expect(service.getLighterFamilyColor('#2a9d8f')).toBe('#55b1a5');
    });
  });
});
