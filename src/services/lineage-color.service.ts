import { Injectable } from '@angular/core';
import { Task } from '../models';
import { FLOATING_TREE_CONFIG } from '../config/layout.config';
import { GoJSNodeData, GoJSLinkData } from '../app/features/flow/services/flow-diagram-config.service';

/**
 * 预处理后的节点数据（包含血缘信息）
 */
export interface LineageNodeData extends GoJSNodeData {
  /** 始祖节点索引 */
  rootAncestorIndex: number;
  /** 家族专属颜色 */
  familyColor: string;
}

/**
 * 预处理后的连线数据（包含血缘信息）
 */
export interface LineageLinkData extends GoJSLinkData {
  /** 始祖节点索引 */
  rootAncestorIndex: number;
  /** 家族专属颜色 */
  familyColor: string;
}

interface RootLineage {
  rootId: string;
  rootIndex: number;
}

/**
 * 高对比度预定义调色板
 * 经过精心挑选，确保：
 * - 相邻颜色有明显区分度
 * - 色盲友好（避免纯红/绿组合）
 * - 在深色/浅色背景上都清晰可见
 */
const HIGH_CONTRAST_PALETTE: string[] = [
  '#e63946',  // 红色（玫瑰红）
  '#2a9d8f',  // 青色（翡翠绿）
  '#e9c46a',  // 黄色（金黄）
  '#457b9d',  // 蓝色（钢蓝）
  '#f4a261',  // 橙色（沙色）
  '#9b5de5',  // 紫色（兰花紫）
  '#00f5d4',  // 青绿（荧光青）
  '#ff6b6b',  // 珊瑚红
  '#4ecdc4',  // 薄荷绿
  '#ffe66d',  // 柠檬黄
  '#95e1d3',  // 淡青
  '#f38181',  // 浅珊瑚
  '#aa96da',  // 淡紫
  '#fcbad3',  // 粉红
  '#a8d8ea',  // 天蓝
  '#fee440',  // 明黄
];

/**
 * 血缘追溯与颜色服务
 * 
 * 职责：
 * - 追溯每个节点的始祖节点（第一代任务）
 * - 基于高对比度调色板为家族分配颜色
 * - 为节点和连线注入血缘信息
 * 
 * 设计原则：
 * - 数据预处理在 GoJS Model 加载之前完成
 * - 优先使用预定义调色板，超出时使用 HSL 生成
 * - 与现有 FlowDiagramConfigService 解耦，可独立测试
 */
@Injectable({
  providedIn: 'root'
})
export class LineageColorService {
  
  // ========== HSL 色彩配置（后备方案）==========
  /** 固定饱和度 (85%) - 高饱和度确保颜色鲜艳 */
  private readonly SATURATION = 85;
  /** 固定亮度 (55%) - 略高亮度确保在深色背景上也清晰 */
  private readonly LIGHTNESS = 55;
  /** 最小色相步长，确保相邻颜色有足够区分度 */
  private readonly MIN_HUE_STEP = 40;
  /** 色相环起始偏移，避免从纯红色开始 */
  private readonly HUE_OFFSET = 15;
  /** HEX 颜色提亮时的混合比例 */
  private readonly HEX_LIGHTEN_MIX = 0.2;
  /** HEX 颜色压暗时的混合比例 */
  private readonly HEX_DARKEN_MIX = 0.18;
  /** FNV-1a 32-bit hash 初始值，用于按根 ID 稳定派生家族色 */
  private readonly HASH_OFFSET_BASIS = 0x811c9dc5;
  /** FNV-1a 32-bit hash 乘数 */
  private readonly HASH_PRIME = 0x01000193;
  /** 稳定色相的饱和度浮动范围，避免大量根节点落在近似颜色上 */
  private readonly STABLE_SATURATION_SPREAD = 15;
  /** 稳定色相的亮度浮动范围，保持深浅模式下的可读性 */
  private readonly STABLE_LIGHTNESS_SPREAD = 13;

  // ========== 【2026-04-24 性能优化】血缘计算结果缓存 ==========
  /**
   * 30+ 任务场景下，每次 title 修改都会触发 preprocessDiagramData。
   * 但血缘追溯 + 根节点颜色仅由 (taskId, parentId) 结构决定，与 title 无关。
   * 因此对 lineageCache / rootColorMap 按“父子结构签名”缓存，减少重复追溯。
   */
  private cachedStructureKey = '';
  private cachedLineage: Map<string, RootLineage> | null = null;
  private cachedRootColorMap: Map<string, string> | null = null;

  private computeStructureKey(tasks: Task[]): string {
    // 按整条 parent-child 记录排序，避免只排序 token 导致不同树结构发生 cache key 碰撞。
    return tasks
      .map(task => `${task.id}>${task.parentId || ''}`)
      .sort()
      .join(';');
  }

  private computeLineageForStructure(tasks: Task[]): {
    lineageCache: Map<string, RootLineage>;
    rootColorMap: Map<string, string>;
  } {
    const taskMap = new Map<string, Task>();
    tasks.forEach(task => taskMap.set(task.id, task));

    const lineageCache = new Map<string, RootLineage>();
    const rootNodes: string[] = [];

    for (const task of tasks) {
      this.traceRootAncestor(task.id, taskMap, lineageCache, rootNodes);
    }

    rootNodes.sort();
    this.applySortedRootIndexes(lineageCache, rootNodes);

    return {
      lineageCache,
      rootColorMap: this.buildRootColorMap(rootNodes),
    };
  }

  private applySortedRootIndexes(
    lineageCache: Map<string, RootLineage>,
    rootNodes: string[],
  ): void {
    const sortedRootIndexMap = new Map<string, number>();
    rootNodes.forEach((rootId, index) => sortedRootIndexMap.set(rootId, index));

    for (const [taskId, lineage] of lineageCache) {
      const sortedIndex = sortedRootIndexMap.get(lineage.rootId) ?? 0;
      lineageCache.set(taskId, { rootId: lineage.rootId, rootIndex: sortedIndex });
    }
  }

  private buildRootColorMap(rootNodes: string[]): Map<string, string> {
    const rootColorMap = new Map<string, string>();
    rootNodes.forEach(rootId => rootColorMap.set(rootId, this.generateStableFamilyColor(rootId)));
    return rootColorMap;
  }
  
  /**
   * 预处理图表数据，注入血缘信息
   * 
   * 核心逻辑：
   * 1. 构建任务 ID 到任务的映射
   * 2. 遍历所有任务，向上追溯始祖节点
   * 3. 为始祖节点分配索引并计算家族颜色
   * 4. 将血缘信息注入到节点和连线数据中
   * 
   * @param nodeDataArray 原始节点数据
   * @param linkDataArray 原始连线数据
   * @param tasks 任务列表（用于追溯父子关系）
   * @returns 包含血缘信息的节点和连线数据
   */
  preprocessDiagramData(
    nodeDataArray: GoJSNodeData[],
    linkDataArray: GoJSLinkData[],
    tasks: Task[]
  ): { nodeDataArray: LineageNodeData[]; linkDataArray: LineageLinkData[] } {

    // 【2026-04-24 性能优化】父子结构未变化时直接复用上次缓存的 lineageCache + rootColorMap，
    // 只对 nodeDataArray / linkDataArray 做一次 map 注入。
    const structureKey = this.computeStructureKey(tasks);
    let lineageCache: Map<string, RootLineage>;
    let rootColorMap: Map<string, string>;

    if (structureKey === this.cachedStructureKey && this.cachedLineage && this.cachedRootColorMap) {
      lineageCache = this.cachedLineage;
      rootColorMap = this.cachedRootColorMap;
    } else {
      const computedLineage = this.computeLineageForStructure(tasks);
      lineageCache = computedLineage.lineageCache;
      rootColorMap = computedLineage.rootColorMap;

      this.cachedStructureKey = structureKey;
      this.cachedLineage = lineageCache;
      this.cachedRootColorMap = rootColorMap;
    }

    // 步骤4：为节点注入血缘信息
    const enhancedNodes: LineageNodeData[] = nodeDataArray.map(node => {
      const lineage = lineageCache.get(node.key);
      const rootId = lineage?.rootId || node.key;
      const rootIndex = lineage?.rootIndex ?? 0;
      const familyColor = rootColorMap.get(rootId) || this.generateFamilyColor(0, 1);

      return {
        ...node,
        rootAncestorIndex: rootIndex,
        familyColor
      };
    });

    // 步骤5：为连线注入血缘信息（使用源节点的血缘）
    const enhancedLinks: LineageLinkData[] = linkDataArray.map(link => {
      const sourceLineage = lineageCache.get(link.from);
      const rootId = sourceLineage?.rootId || link.from;
      const rootIndex = sourceLineage?.rootIndex ?? 0;
      const familyColor = rootColorMap.get(rootId) || this.generateFamilyColor(0, 1);

      return {
        ...link,
        rootAncestorIndex: rootIndex,
        familyColor
      };
    });

    return {
      nodeDataArray: enhancedNodes,
      linkDataArray: enhancedLinks
    };
  }
  
  /**
   * 追溯任务的始祖节点
   * 
  * 使用迭代向上追溯 parentId 链，直到找到没有父节点的任务（始祖）
   * 结果会被缓存以避免重复计算
   * 
   * @param taskId 当前任务 ID
   * @param taskMap 任务映射
   * @param cache 血缘缓存
   * @param rootNodes 始祖节点列表（按发现顺序）
   * @returns 始祖节点 ID
   */
  private traceRootAncestor(
    taskId: string,
    taskMap: Map<string, Task>,
    cache: Map<string, RootLineage>,
    rootNodes: string[]
  ): string {
    const initialCached = cache.get(taskId);
    if (initialCached) return initialCached.rootId;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = taskId;
    let rootId = taskId;
    let depth = 0;

    while (true) {
      const cached = cache.get(currentId);
      if (cached) {
        rootId = cached.rootId;
        break;
      }

      if (visited.has(currentId)) {
        rootId = currentId;
        break;
      }

      visited.add(currentId);
      path.push(currentId);

      const task = taskMap.get(currentId);
      if (!task?.parentId || depth >= FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) {
        rootId = currentId;
        break;
      }

      currentId = task.parentId;
      depth += 1;
    }

    const rootIndex = this.getOrAddRootIndex(rootId, rootNodes);
    path.forEach(pathTaskId => cache.set(pathTaskId, { rootId, rootIndex }));

    return rootId;
  }
  
  /**
   * 获取或添加始祖节点索引
   */
  private getOrAddRootIndex(rootId: string, rootNodes: string[]): number {
    const existingIndex = rootNodes.indexOf(rootId);
    if (existingIndex >= 0) {
      return existingIndex;
    }
    rootNodes.push(rootId);
    return rootNodes.length - 1;
  }
  
  /**
   * 基于高对比度调色板生成家族颜色
   * 
   * 算法原理：
   * - 优先使用预定义的高对比度调色板（前16个家族）
   * - 超出调色板时，使用 HSL 黄金角度算法生成
   * - 确保即使相邻索引也有明显的视觉区分
   * 
   * @param index 始祖节点索引（从 0 开始）
   * @param totalRoots 始祖节点总数
   * @returns 颜色字符串（HEX 或 HSL 格式）
   */
  generateFamilyColor(index: number, totalRoots: number): string {
    // 优先使用预定义的高对比度调色板
    if (index < HIGH_CONTRAST_PALETTE.length) {
      return HIGH_CONTRAST_PALETTE[index];
    }
    
    // 超出调色板范围时，使用 HSL 黄金角度算法
    if (totalRoots <= 0) {
      return `hsl(${this.HUE_OFFSET}, ${this.SATURATION}%, ${this.LIGHTNESS}%)`;
    }
    
    // 使用黄金角度（约137.5度）来分布颜色
    const goldenAngle = 137.508;
    const hue = (this.HUE_OFFSET + index * goldenAngle) % 360;
    
    return `hsl(${Math.round(hue)}, ${this.SATURATION}%, ${this.LIGHTNESS}%)`;
  }

  private generateStableFamilyColor(rootId: string): string {
    const hash = this.hashRootId(rootId);
    const hue = (this.HUE_OFFSET + (hash % 360)) % 360;
    const saturation = this.SATURATION - 7 + ((hash >>> 9) % this.STABLE_SATURATION_SPREAD);
    const lightness = this.LIGHTNESS - 7 + ((hash >>> 18) % this.STABLE_LIGHTNESS_SPREAD);

    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  private hashRootId(rootId: string): number {
    let hash = this.HASH_OFFSET_BASIS;

    for (let index = 0; index < rootId.length; index += 1) {
      hash ^= rootId.charCodeAt(index);
      hash = Math.imul(hash, this.HASH_PRIME);
    }

    return hash >>> 0;
  }
  
  /**
   * 将 HSL 颜色转换为 HEX 格式
   * 用于不支持 HSL 的场景
   */
  hslToHex(hslColor: string): string {
    const match = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return hslColor;
    
    const h = parseInt(match[1], 10);
    const s = parseInt(match[2], 10) / 100;
    const l = parseInt(match[3], 10) / 100;
    
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    
    let r = 0, g = 0, b = 0;
    
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    
    const toHex = (v: number) => {
      const hex = Math.round((v + m) * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private parseHexColor(hexColor: string): { r: number; g: number; b: number } | null {
    const normalized = hexColor.trim().replace('#', '');
    const fullHex = normalized.length === 3
      ? normalized.split('').map(char => `${char}${char}`).join('')
      : normalized;

    if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) {
      return null;
    }

    return {
      r: parseInt(fullHex.slice(0, 2), 16),
      g: parseInt(fullHex.slice(2, 4), 16),
      b: parseInt(fullHex.slice(4, 6), 16),
    };
  }

  private toHexColor({ r, g, b }: { r: number; g: number; b: number }): string {
    const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private mixHexColor(
    familyColor: string,
    mixRatio: number,
    targetChannel: number,
  ): string | null {
    const rgb = this.parseHexColor(familyColor);
    if (!rgb) {
      return null;
    }

    const mixChannel = (channel: number) => channel + ((targetChannel - channel) * mixRatio);

    return this.toHexColor({
      r: mixChannel(rgb.r),
      g: mixChannel(rgb.g),
      b: mixChannel(rgb.b),
    });
  }
  
  /**
   * 获取家族颜色的亮色版本（用于高亮显示）
   */
  getLighterFamilyColor(familyColor: string): string {
    const match = familyColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) {
      return this.mixHexColor(familyColor, this.HEX_LIGHTEN_MIX, 255) ?? familyColor;
    }
    
    const h = match[1];
    const s = match[2];
    // 增加亮度 20%
    const newL = Math.min(parseInt(match[3], 10) + 20, 85);
    
    return `hsl(${h}, ${s}%, ${newL}%)`;
  }
  
  /**
   * 获取家族颜色的暗色版本（用于边框或强调）
   */
  getDarkerFamilyColor(familyColor: string): string {
    const match = familyColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) {
      return this.mixHexColor(familyColor, this.HEX_DARKEN_MIX, 0) ?? familyColor;
    }
    
    const h = match[1];
    const s = match[2];
    // 降低亮度 15%
    const newL = Math.max(parseInt(match[3], 10) - 15, 25);
    
    return `hsl(${h}, ${s}%, ${newL}%)`;
  }
}
