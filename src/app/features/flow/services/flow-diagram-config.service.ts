import { Injectable, inject, computed } from '@angular/core';
import { ThemeService } from '../../../../services/theme.service';
import { getFlowStyles, FlowStyleConfig, FlowTheme } from '../../../../config/flow-styles';
import { GOJS_CONFIG, SUPERSCRIPT_DIGITS } from '../../../../config';
import { LAYOUT_CONFIG } from '../../../../config/layout.config';
import { Task, Project } from '../../../../models';
import { LayoutService } from '../../../../services/layout.service';
import { LineageColorService } from '../../../../services/lineage-color.service';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import * as go from 'gojs';

/**
 * GoJS 节点数据结构
 */
export interface GoJSNodeData {
  key: string;
  title: string;
  displayId: string;
  stage: number | null;
  parentId: string | null;
  status: Task['status'];
  rank?: number;
  loc: string;
  color: string;
  borderColor: string;
  borderWidth: number;
  titleColor: string;
  displayIdColor: string;
  selectedBorderColor: string;
  isUnassigned: boolean;
  isSearchMatch: boolean;
  isSelected: boolean;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
  /** 是否已被停泊 */
  isParked?: boolean;
  /** 是否已入坞（本地专注控制台状态） */
  isDocked?: boolean;
  /** 是否为当前专注中的入坞任务 */
  isDockFocused?: boolean;
  /** 当前任务是否已关联思源锚点 */
  hasSiyuanLink?: boolean;
  /** 用于流程图节点徽标 hover/click 预览的首个思源锚点 */
  siyuanLink?: ExternalSourceLink;
  /** 当前流程图徽标对应的可见锚点序号（1-based） */
  siyuanLinkBadgeIndex?: number;
}

/**
 * GoJS 连接数据结构
 */
export interface GoJSLinkData {
  key: string;
  from: string;
  to: string;
  isCrossTree: boolean;
  /** 稳定曲率：避免 GoJS 在刷新/重建后按自动曲率重新选择路径。 */
  curviness?: number;
  /** 联系块标题（外显内容） */
  title?: string;
  /** 联系块详细描述 */
  description?: string;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
  /**
   * 【2026-02-25 性能优化】GoJS link template category
   * 空字符串 = 默认模板（父子链接，无 label panel）
   * 'crossTree' = 跨树链接模板（含 label panel + tooltip）
   */
  category?: string;
  /**
   * 【关联块错开 2026-04-23】同一 stage-pair 内跨树链接的 label 沿线长方
    * 向的错开位置（范围 0.10-0.90）。默认靠近 target 端三分之一处，
    * 同 stage-pair 多链接时自动分散避免关联块堆叠。
   */
  labelSegmentFraction?: number;
  /**
    * 【关联块错开 2026-04-23】保留给旧快照/兼容路径的 label 偏移字段。
    * 新布局默认保持关联块嵌在线内，此值通常为 0。
   */
  labelSegmentOffsetY?: number;
}

const FLOW_LINK_ROUTE_CONFIG = {
  PARENT_CHILD_CURVINESS: 20,
  CROSS_TREE_CURVINESS: 18,
  PARALLEL_CURVINESS_STEP: 12,
} as const;

/**
 * GoJS 图表数据
 */
export interface GoJSDiagramData {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}

/**
 * 流程图配置服务
 * 
 * 职责：
 * - 提供 GoJS 节点和连接线模板配置
 * - 构建图表数据（从任务数据转换为 GoJS 数据）
 * - 管理主题样式
 * 
 * 设计原则：
 * - 纯配置和数据转换逻辑，不持有 GoJS Diagram 实例
 * - 所有配置集中在此处，FlowViewComponent 只负责视图交互
 * - 可独立测试
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramConfigService {
  private readonly themeService = inject(ThemeService);
  private readonly lineageColorService = inject(LineageColorService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService, { optional: true });
  private readonly layoutService = inject(LayoutService);

  /** 当前主题样式配置（响应式） */
  readonly currentStyles = computed(() => {
    const theme = this.themeService.theme() as FlowTheme;
    return getFlowStyles(theme);
  });

  // ========== 图表配置常量 ==========

  /** 布局配置 */
  readonly layoutConfig = {
    layerSpacing: GOJS_CONFIG.LAYER_SPACING,
    columnSpacing: GOJS_CONFIG.COLUMN_SPACING,
    scrollMargin: GOJS_CONFIG.SCROLL_MARGIN
  } as const;

  /** 节点配置 */
  readonly nodeConfig = {
    unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH,
    assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH,
    cornerRadius: 10,
    portSize: GOJS_CONFIG.PORT_SIZE
  } as const;

  /** 连接线配置 */
  readonly linkConfig = {
    cornerRadius: 20,  // 增加圆角
    toShortLength: 5,  // 减小偏移量，让箭头更贴近目标节点（之前 10 太大会导致箭头角度计算问题）
    mobileStrokeWidth: 24,   // 移动端透明触控区域
    desktopStrokeWidth: 14,  // 桌面端透明触控区域
    visibleStrokeWidth: 6,   // 可见线条粗度：增加至6使其更明显
    arrowType: "Standard",   // 实心三角箭头
    arrowScale: 0.9,         // 调小补偿粗描边带来的视觉膨胀
    arrowStrokeWidth: 7      // 粗描边让 strokeJoin: round 生效，呈现圆角效果
  } as const;

  // ========== 数据构建方法 ==========

  /**
   * 从任务列表构建 GoJS 图表数据
   * @param tasks 任务列表
   * @param project 当前项目（用于获取连接信息）
   * @param searchQuery 搜索关键词（用于高亮）
   * @param existingNodeMap 现有节点数据映射（用于保持位置）
   */
  buildDiagramData(
    tasks: Task[],
    project: Project,
    searchQuery: string,
    existingNodeMap: Map<string, go.ObjectData>,
    dockState: { dockedTaskIds: ReadonlySet<string>; focusedTaskId: string | null },
  ): GoJSDiagramData {
    const styles = this.currentStyles();
    const nodeDataArray: GoJSNodeData[] = [];
    const linkDataArray: GoJSLinkData[] = [];
    const resolvedDisplayIds = this.createDisplayIdLookup(tasks, project);

    // 构建父子关系集合
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });

    // 过滤显示的任务：只排除已归档的任务
    // 待分配任务（stage === null）也应该显示，不应该因为坐标为(0,0)而被过滤
    const tasksToShow = tasks.filter(t => t.status !== 'archived');

    let newNodeIndex = 0;
    const searchLower = searchQuery.toLowerCase().trim();

    for (const task of tasksToShow) {
      // 计算节点位置
      const loc = this.computeNodeLocation(task, existingNodeMap, newNodeIndex);
      if (!existingNodeMap.has(task.id) && task.x === 0 && task.y === 0) {
        newNodeIndex++;
      }

      // 检查是否匹配搜索
      const isSearchMatch = this.isTaskSearchMatch(task, searchLower);

      // 计算节点颜色
      const { nodeColor, borderColor, borderWidth, titleColor } =
        this.computeNodeColors(task, isSearchMatch, styles);

      const isParked = task.parkingMeta?.state === 'parked';
      const isDocked = dockState.dockedTaskIds.has(task.id);
      const isDockFocused = dockState.focusedTaskId === task.id;
      const siyuanLinks = this.externalSourceLinks?.activeLinksForTask(task.id) ?? [];
      const siyuanLink = siyuanLinks[0] ?? undefined;
      const siyuanLinkBadgeIndex = siyuanLink
        ? Math.max(siyuanLinks.findIndex(link => link.id === siyuanLink.id), 0) + 1
        : undefined;

      nodeDataArray.push({
        key: task.id,
        title: task.title || '未命名任务',
        displayId: this.compressDisplayId(this.resolveDisplayId(task, resolvedDisplayIds)),
        stage: task.stage,
        parentId: task.parentId,
        status: task.status,
        // 【关键修复 2026-04-16】rank 字段必须下沉到 nodeDataArray，否则
        // 自动布局服务 (FlowLayoutService) 的 compareLayoutNodes/compareRootNodes
        // 会读到 undefined，退化为仅按 key 字符串排序，rank 这个用户意图
        // 最核心的因子将被彻底忽略。
        rank: task.rank,
        loc,
        color: nodeColor,
        borderColor: isParked ? '#d97706' : borderColor, // Amber-600 outline if parked
        borderWidth: isParked ? 2 : borderWidth,
        titleColor,
        displayIdColor: styles.text.displayIdColor,
        selectedBorderColor: styles.node.selectedBorder,
        isUnassigned: task.stage === null,
        isSearchMatch,
        isSelected: false,
        isParked: isParked,
        isDocked,
        isDockFocused,
        hasSiyuanLink: Boolean(siyuanLink),
        siyuanLink,
        siyuanLinkBadgeIndex,
      });

      // 添加父子连接
      if (task.parentId) {
        linkDataArray.push({
          key: `${task.parentId}-${task.id}`,
          from: task.parentId,
          to: task.id,
          isCrossTree: false
        });
      }
    }

    // 添加跨树连接（过滤掉已软删除的连接）
    // 【P2-30 修复】使用 Set 实现 O(1) 查找，避免 O(n*m)
    const taskIdSet = new Set(tasksToShow.map(t => t.id));
    // 【关联块错开 2026-04-23】按任务 id -> stage 建索引，用于后续按
    // (fromStage, toStage) 分组计算 label 错开位置。
    const taskStageMap = new Map<string, number | null>(
      tasksToShow.map(t => [t.id, t.stage]),
    );
    // 【补丁 G 2026-04-23 14:55】按 stage -> 节点数索引，用于 label 二次避让
    // 判定"节点密集区"。stage=null 的任务不参与边界密度计算。
    const stageNodeCount = new Map<number, number>();
    for (const t of tasksToShow) {
      if (t.stage === null) continue;
      stageNodeCount.set(t.stage, (stageNodeCount.get(t.stage) ?? 0) + 1);
    }
    const crossTreeLinksToStagger: GoJSLinkData[] = [];
    for (const conn of project.connections) {
      // 跳过已软删除的连接
      if (conn.deletedAt) continue;

      const pairKey = `${conn.source}->${conn.target}`;
      if (!parentChildPairs.has(pairKey)) {
        if (taskIdSet.has(conn.source) && taskIdSet.has(conn.target)) {
          const linkData: GoJSLinkData = {
            key: `cross-${conn.source}-${conn.target}`,
            from: conn.source,
            to: conn.target,
            isCrossTree: true,
            // 【2026-02-25 性能优化】跨树链接使用独立模板，含 label panel + tooltip
            category: 'crossTree',
            title: conn.title || '',
            description: conn.description || '',
            labelSegmentFraction: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
            labelSegmentOffsetY: 0,
          };
          linkDataArray.push(linkData);
          crossTreeLinksToStagger.push(linkData);
        }
      }
    }

    // 【关联块错开 2026-04-23】同 stage-pair 的多条跨树链接 label
    // 原先都钉在 segmentFraction=0.5，视觉上关联块完全重叠在同一条中线
    // 附近。此处按 (minStage, maxStage) 分组，给组内每条链接赋予不同的
    // 沿线位置 + 垂直偏移，空间层面把关联块分散开。
    this.assignCrossTreeLabelStagger(crossTreeLinksToStagger, taskStageMap, stageNodeCount);
    this.assignStableLinkCurviness(linkDataArray);
    linkDataArray.sort((a, b) => this.compareLinkData(a, b));

    // ========== 血缘追溯预处理 ==========
    // 在数据加载进 GoJS Model 之前，为每个节点和连线注入始祖信息和家族颜色
    // 这是"领地热力图"效果的数据基础
    const enhancedData = this.lineageColorService.preprocessDiagramData(
      nodeDataArray,
      linkDataArray,
      tasksToShow
    );

    return {
      nodeDataArray: enhancedData.nodeDataArray.map(node => {
        if (node.stage === null || node.isSearchMatch || !node.familyColor) {
          return node;
        }

        return {
          ...node,
          // 用家族色轻微强化 displayId，让自动整理后的纵向分区更容易扫读。
          displayIdColor: this.lineageColorService.getDarkerFamilyColor(node.familyColor),
        };
      }),
      linkDataArray: enhancedData.linkDataArray,
    };
  }

  /**
   * 【关联块错开 2026-04-23 / 补丁 F 碰撞检测 14:50】
   *
   * 问题：早期 v1 按 (minStage, maxStage) 的方向无关 pair 分组，会漏掉
   * "不同 pair 但在同一 stage 边界上 label X 相同"的碰撞（例如 0→3 和
   * 1→2 两条链接都穿越 stage1 和 stage2 之间的边界，label 可能都落在
   * 同一 X 附近）。
   *
   * 新算法：按"链接实际穿越的 stage 边界"做贪心分配。
   *   1. 每条跨树链接 [minStage, maxStage] 穿越边界 b ∈ [minStage, maxStage)。
  *   2. 按 span 升序（窄范围优先，选择余地少），为每条链接挑选"当前最空
  *      且最靠近 target 端三分之一处的边界"作为 label 锚点；填入该边界桶，slot = 桶内序号。
  *   3. segmentFraction 基于锚点边界相对链接 from->to 方向的位置计算，
  *      同一边界桶内按 slot 做微抖动，全部沿线分散，不再把关联块抬离连线。
  *   4. span=0（同 stage 跨树连线）单独分组，也只在连线内部做前后分散。
   *
   * 复杂度 O(L * S)：L=跨树链接数，S=stage 数。典型项目 L<100、S<10。
   */
  private assignCrossTreeLabelStagger(
    crossTreeLinks: GoJSLinkData[],
    taskStageMap: Map<string, number | null>,
    stageNodeCount: Map<number, number>,
  ): void {
    if (crossTreeLinks.length < 2) return;

    const FRACTION_STEP = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_FRACTION_STEP;
    const TARGET_SIDE_FRACTION = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION;
    const FRACTION_MIN = 0.08;
    const FRACTION_MAX = 0.92;
    const DENSE_THRESHOLD = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_THRESHOLD;
    // 复用历史密集区增强倍数常量；当前用于放大沿线分散步长，而不是垂直抬离。
    const DENSE_BOOST = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_VERTICAL_BOOST;

    interface LinkSpan {
      readonly link: GoJSLinkData;
      readonly fromStage: number;
      readonly toStage: number;
      readonly minStage: number;
      readonly maxStage: number;
    }

    const crossSpans: LinkSpan[] = [];
    const zeroSpans: LinkSpan[] = [];
    for (const link of crossTreeLinks) {
      const a = taskStageMap.get(link.from);
      const b = taskStageMap.get(link.to);
      if (a === undefined || a === null || b === undefined || b === null) continue;
      const span: LinkSpan = {
        link,
        fromStage: a,
        toStage: b,
        minStage: Math.min(a, b),
        maxStage: Math.max(a, b),
      };
      if (span.maxStage === span.minStage) {
        zeroSpans.push(span);
      } else {
        crossSpans.push(span);
      }
    }

    // === span>0 链接：边界贪心分配 ===
    // 窄跨度优先（选择余地少）；同跨度按 key 稳定排序。
    crossSpans.sort((x, y) => {
      const ds = (x.maxStage - x.minStage) - (y.maxStage - y.minStage);
      if (ds !== 0) return ds;
      return x.link.key.localeCompare(y.link.key);
    });

    // boundary b = stage b 与 stage b+1 之间的列间隙
    const boundaryBuckets = new Map<number, LinkSpan[]>();
    const linkAssignments = new Map<string, { boundary: number; slot: number }>();
    for (const span of crossSpans) {
      const rangeSpan = span.maxStage - span.minStage;
      const desiredFractionFromMin = span.fromStage === span.minStage
        ? TARGET_SIDE_FRACTION
        : 1 - TARGET_SIDE_FRACTION;
      let bestBoundary = span.minStage;
      let bestSize = Infinity;
      let bestDistance = Infinity;
      // 选跨度内最空的边界；并列时选更靠近 target 端三分之一的位置。
      for (let b = span.minStage; b < span.maxStage; b += 1) {
        const size = boundaryBuckets.get(b)?.length ?? 0;
        const boundaryFractionFromMin = (b - span.minStage + 0.5) / rangeSpan;
        const distance = Math.abs(boundaryFractionFromMin - desiredFractionFromMin);
        if (size < bestSize || (size === bestSize && distance < bestDistance)) {
          bestSize = size;
          bestDistance = distance;
          bestBoundary = b;
        }
      }
      let bucket = boundaryBuckets.get(bestBoundary);
      if (!bucket) {
        bucket = [];
        boundaryBuckets.set(bestBoundary, bucket);
      }
      const slot = bucket.length;
      bucket.push(span);
      linkAssignments.set(span.link.key, { boundary: bestBoundary, slot });
    }

    // 计算每条 span>0 链接的 fraction + offset
    for (const span of crossSpans) {
      const assignment = linkAssignments.get(span.link.key);
      if (!assignment) continue;
      const bucket = boundaryBuckets.get(assignment.boundary);
      if (!bucket) continue;
      const n = bucket.length;
      const { boundary, slot } = assignment;
      const rangeSpan = span.maxStage - span.minStage;
      // 锚点边界在链接 minStage->maxStage 方向上的分数位置
      const baseFractionFromMin = (boundary - span.minStage + 0.5) / rangeSpan;
      const baseFractionFromSource = rangeSpan === 1
        ? TARGET_SIDE_FRACTION
        : span.fromStage === span.minStage
        ? baseFractionFromMin
        : 1 - baseFractionFromMin;
      // 桶内微抖动：同一边界内多条 label 继续沿 fraction 分散，并按当前
      // 链接可用的 fraction 空间自动收缩步长，避免高密度下撞到 clamp 后
      // 再次重叠。
      const countL = stageNodeCount.get(boundary) ?? 0;
      const countR = stageNodeCount.get(boundary + 1) ?? 0;
      const denseBoost = Math.min(countL, countR) >= DENSE_THRESHOLD ? DENSE_BOOST : 1;
      span.link.labelSegmentFraction = this.computeEmbeddedLabelFraction(
        baseFractionFromSource,
        slot,
        n,
        (FRACTION_STEP * 0.5 * denseBoost) / rangeSpan,
        FRACTION_MIN,
        FRACTION_MAX,
      );
      span.link.labelSegmentOffsetY = 0;
    }

    // === span=0 链接：同 stage 跨树，按 stage 分桶仅做垂直错开 ===
    if (zeroSpans.length > 1) {
      const sameStageBuckets = new Map<number, LinkSpan[]>();
      for (const span of zeroSpans) {
        let bucket = sameStageBuckets.get(span.minStage);
        if (!bucket) {
          bucket = [];
          sameStageBuckets.set(span.minStage, bucket);
        }
        bucket.push(span);
      }
      for (const bucket of sameStageBuckets.values()) {
        if (bucket.length < 2) continue;
        bucket.sort((x, y) => x.link.key.localeCompare(y.link.key));
        const n = bucket.length;
        // span=0 同 stage 密集判定：该 stage 自身节点数 >= DENSE_THRESHOLD
        const stageForBucket = bucket[0].minStage;
        const isDense = (stageNodeCount.get(stageForBucket) ?? 0) >= DENSE_THRESHOLD;
        const fractionStep = FRACTION_STEP * (isDense ? DENSE_BOOST : 1);
        for (let i = 0; i < n; i++) {
          bucket[i].link.labelSegmentFraction = this.computeEmbeddedLabelFraction(
            TARGET_SIDE_FRACTION,
            i,
            n,
            fractionStep,
            FRACTION_MIN,
            FRACTION_MAX,
          );
          bucket[i].link.labelSegmentOffsetY = 0;
        }
      }
    }
  }

  private computeEmbeddedLabelFraction(
    baseFraction: number,
    slot: number,
    bucketSize: number,
    preferredStep: number,
    minFraction: number,
    maxFraction: number,
  ): number {
    const clampedBase = Math.min(maxFraction, Math.max(minFraction, baseFraction));
    if (bucketSize <= 1) {
      return clampedBase;
    }

    const normalizedPreferredStep = Math.max(0, preferredStep);
    const mid = (bucketSize - 1) / 2;
    const preferredHalfSpan = normalizedPreferredStep * mid;
    const minCenter = minFraction + preferredHalfSpan;
    const maxCenter = maxFraction - preferredHalfSpan;

    const centeredBase = minCenter <= maxCenter
      ? Math.min(maxCenter, Math.max(minCenter, baseFraction))
      : (minFraction + maxFraction) / 2;
    const safeStep = minCenter <= maxCenter
      ? normalizedPreferredStep
      : (maxFraction - minFraction) / Math.max(bucketSize - 1, 1);

    return Math.min(
      maxFraction,
      Math.max(minFraction, centeredBase + (slot - mid) * safeStep),
    );
  }

  private assignStableLinkCurviness(linkDataArray: GoJSLinkData[]): void {
    const linksByEndpoint = new Map<string, GoJSLinkData[]>();

    for (const link of linkDataArray) {
      const bucketKey = `${link.from}->${link.to}|${link.category ?? ''}`;
      const bucket = linksByEndpoint.get(bucketKey) ?? [];
      bucket.push(link);
      linksByEndpoint.set(bucketKey, bucket);
    }

    for (const bucket of linksByEndpoint.values()) {
      bucket.sort((a, b) => this.compareLinkData(a, b));
      if (bucket.length === 1) {
        bucket[0].curviness = this.getBaseLinkCurviness(bucket[0]);
        continue;
      }

      const middle = (bucket.length - 1) / 2;
      bucket.forEach((link, index) => {
        const spread = (index - middle) * FLOW_LINK_ROUTE_CONFIG.PARALLEL_CURVINESS_STEP;
        link.curviness = spread === 0 ? this.getBaseLinkCurviness(link) : spread;
      });
    }
  }

  private getBaseLinkCurviness(link: GoJSLinkData): number {
    return link.isCrossTree
      ? FLOW_LINK_ROUTE_CONFIG.CROSS_TREE_CURVINESS
      : FLOW_LINK_ROUTE_CONFIG.PARENT_CHILD_CURVINESS;
  }

  private compareLinkData(a: GoJSLinkData, b: GoJSLinkData): number {
    const categoryCompare = Number(a.isCrossTree) - Number(b.isCrossTree);
    if (categoryCompare !== 0) return categoryCompare;

    return a.key.localeCompare(b.key);
  }

  /**
   * 计算节点位置
   */
  private computeNodeLocation(
    task: Task,
    existingNodeMap: Map<string, go.ObjectData>,
    newNodeIndex: number
  ): string {
    const existingNode = existingNodeMap.get(task.id);

    if (existingNode?.loc) {
      // 优先保持现有位置
      return existingNode.loc;
    } else if (task.x !== 0 || task.y !== 0) {
      // 使用 store 中保存的位置
      return `${task.x} ${task.y}`;
    } else {
      // 新节点：根据阶段和顺序计算初始位置
      const stageX = ((task.stage || 1) - 1) * 150;
      const indexY = newNodeIndex * 100;
      return `${stageX} ${indexY}`;
    }
  }

  /**
   * 检查任务是否匹配搜索
   */
  private isTaskSearchMatch(task: Task, searchLower: string): boolean {
    if (!searchLower) return false;

    return (
      task.title.toLowerCase().includes(searchLower) ||
      task.content.toLowerCase().includes(searchLower) ||
      task.displayId.toLowerCase().includes(searchLower) ||
      (task.attachments?.some(a => a.name.toLowerCase().includes(searchLower)) ?? false) ||
      (task.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ?? false)
    );
  }

  /**
   * 计算节点颜色
   */
  private computeNodeColors(
    task: Task,
    isSearchMatch: boolean,
    styles: FlowStyleConfig
  ): {
    nodeColor: string;
    borderColor: string;
    borderWidth: number;
    titleColor: string;
  } {
    if (isSearchMatch) {
      return {
        nodeColor: styles.node.searchHighlightBackground,
        borderColor: styles.node.searchHighlightBorder,
        borderWidth: 2,
        titleColor: styles.text.titleColor
      };
    } else if (task.stage === null) {
      return {
        nodeColor: styles.node.unassignedBackground,
        borderColor: styles.node.unassignedBorder,
        borderWidth: 2,
        titleColor: styles.text.unassignedTitleColor
      };
    } else if (task.status === 'completed') {
      return {
        nodeColor: styles.node.completedBackground,
        borderColor: styles.node.defaultBorder,
        borderWidth: 1,
        titleColor: styles.text.titleColor
      };
    } else {
      return {
        nodeColor: styles.node.background,
        borderColor: styles.node.defaultBorder,
        borderWidth: 1,
        titleColor: styles.text.titleColor
      };
    }
  }

  /**
   * 压缩 displayId 显示（如 A,A,A,A,A → A⁵）
   */
  private createDisplayIdLookup(tasks: Task[], project: Project): ReadonlyMap<string, string> {
    const needsNumbering = tasks.some(task => this.needsDisplayIdRenumbering(task));
    if (!needsNumbering) {
      return new Map();
    }

    const rebalancedProject = this.layoutService.rebalance({ ...project, tasks });
    return new Map(rebalancedProject.tasks.map(task => [task.id, task.displayId]));
  }

  private needsDisplayIdRenumbering(task: Task): boolean {
    if (task.stage === null) {
      return false;
    }

    const displayId = (task.displayId ?? '').trim();
    return displayId === '' || displayId === '?';
  }

  private resolveDisplayId(task: Task, resolvedDisplayIds: ReadonlyMap<string, string>): string {
    return resolvedDisplayIds.get(task.id) ?? task.displayId;
  }

  private compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;

    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;

    while (i < parts.length) {
      const current = parts[i];
      let count = 1;

      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }

      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d] || d).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }

      i += count;
    }

    return result.join(',');
  }

  // ========== 模板工厂方法 ==========

  /**
   * 创建端口
   * 使用圆点端口，悬停时显示边框发光效果
   * 
   * 设计原则：
   * - 端口仅作为交互手柄（UI Handle），不参与连接线锚点计算
   * - fromSpot/toSpot 设为 None，避免在端口微小边界上计算
   * - 实际锚点由主节点 + getLinkPoint 在节点边界（Perimeter）上计算
   */
  createPort($: typeof go.GraphObject.make, name: string, spot: go.Spot, output: boolean, input: boolean, isMobile: boolean = false): go.Shape {
    const portSize = isMobile ? 24 : 8;  // 移动端增大到 24px 便于触摸

    return $(go.Shape, "Circle", {
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: isMobile ? 3 : 2,  // 移动端加粗边框
      desiredSize: new go.Size(portSize, portSize),
      alignment: spot,
      alignmentFocus: spot,
      portId: name,
      fromLinkable: output,
      toLinkable: input,
      cursor: "pointer",
      // ========== 关键：端口不设置 Spot ==========
      // 让连接线锚点在主节点边界计算，而不是在端口边界
      fromSpot: go.Spot.None,
      toSpot: go.Spot.None,
      // 鼠标悬停时显示边框发光
      mouseEnter: (_e: go.InputEvent, obj: go.GraphObject) => {
        if (_e.diagram?.isReadOnly) return;
        const port = obj as go.Shape;
        port.stroke = "#6366f1";
        port.fill = "rgba(99, 102, 241, 0.15)";
      },
      mouseLeave: (_e: go.InputEvent, obj: go.GraphObject) => {
        const port = obj as go.Shape;
        port.stroke = "transparent";
        port.fill = "transparent";
      }
    });
  }

  /**
   * 获取节点主面板配置
   */
  getNodeMainPanelConfig($: typeof go.GraphObject.make): go.Panel {
    return $(go.Panel, "Spot",
      $(go.Panel, "Auto",
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) =>
          isUnassigned ? this.nodeConfig.unassignedWidth : this.nodeConfig.assignedWidth),
        $(go.Shape, "RoundedRectangle", {
          fill: "white",
          stroke: "#e7e5e4",
          strokeWidth: 1,
          parameter1: this.nodeConfig.cornerRadius,
          portId: "",              // 主体端口（用于连接线终点计算）
          fromLinkable: false,     // 不直接从主体拉线（由边缘小圆点触发后切换）
          toLinkable: true,        // 允许连接到主体（配合 findTargetPort 实现边界吸附）
          cursor: "move",
          fromSpot: go.Spot.AllSides,  // Perimeter Intersection：动态计算边界交点
          toSpot: go.Spot.AllSides     // 让连接线像水珠一样沿边界滑动
        },
          new go.Binding("fill", "color"),
          // stroke 初始值由 borderColor 数据属性决定；选中态由 Node 的 selectionChanged 回调处理
          new go.Binding("stroke", "borderColor"),
          new go.Binding("strokeWidth", "borderWidth")),

        $(go.Panel, "Vertical",
          new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
          $(go.TextBlock, { font: "bold 9px 'LXGW WenKai Screen', sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
            new go.Binding("text", "displayId"),
            new go.Binding("stroke", "displayIdColor"),
            new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
          $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px 'LXGW WenKai Screen', sans-serif", stroke: "#57534e" },
            new go.Binding("text", "title"),
            new go.Binding("font", "isUnassigned", (isUnassigned: boolean) =>
              isUnassigned ? "500 11px 'LXGW WenKai Screen', sans-serif" : "400 12px 'LXGW WenKai Screen', sans-serif"),
            new go.Binding("stroke", "titleColor"),
            new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) =>
              isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
        )
      ),
      // 停泊徽章 (Parked Badge)
      $(go.Panel, "Auto",
        {
          alignment: new go.Spot(1, 0, -4, 4), // Top-right corner, slightly inset
          visible: false
        },
        new go.Binding("visible", "isParked"),
        $(go.Shape, "RoundedRectangle", {
          fill: "#fef3c7", // amber-50
          stroke: "#d97706", // amber-600
          strokeWidth: 1,
          parameter1: 4
        }),
        $(go.TextBlock, "⏸ 停泊", {
          font: "500 8px 'LXGW WenKai Screen', sans-serif",
          stroke: "#d97706",
          margin: new go.Margin(2, 4, 2, 4)
        })
      )
    );
  }

  /**
   * 获取连接线主体配置
   * 
   * 视觉设计：
   * - 父子连线使用血缘追溯的家族颜色（familyColor）
   * - 跨树连线保持紫色虚线样式以区分
   * - 颜色来源于数据预处理阶段注入的 familyColor 属性
   */
  getLinkMainShapesConfig($: typeof go.GraphObject.make, isMobile: boolean): go.Shape[] {
    const styles = this.currentStyles();

    return [
      // 透明粗线便于选择（触控区域）
      $(go.Shape, {
        isPanelMain: true,
        strokeWidth: isMobile ? this.linkConfig.mobileStrokeWidth : this.linkConfig.desktopStrokeWidth,
        stroke: "transparent",
        strokeCap: "round",
        strokeJoin: "round"
      }),
      // 可见线 - 使用家族颜色（血缘聚类）
      $(go.Shape, {
        isPanelMain: true,   // 标记为主路径线，让 GoJS 正确计算曲线路径
        strokeWidth: this.linkConfig.visibleStrokeWidth,
        strokeCap: "round",  // 线端圆润（解决锐度问题）
        strokeJoin: "round"  // 拐角圆润
      },
        // 绑定血缘家族颜色，跨树连线保持紫色
        new go.Binding("stroke", "", (data: go.ObjectData) => {
          if (data.isCrossTree) return styles.link.crossTreeColor; // 使用主题定义的跨树连线颜色
          return (data.familyColor as string) || styles.link.parentChildColor; // 优先使用血缘颜色，否则使用主题定义的父子颜色
        }),
        new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 10] : null)),
      // 箭头 - 使用粗描边 + strokeJoin: round 实现圆角效果
      // ========== 圆角箭头核心原理 ==========
      // 1. toArrow: "Standard" 是实心三角的几何基础
      // 2. fill 和 stroke 必须一致，才能看起来是纯色填充
      // 3. strokeWidth 要足够大（3-5），让 strokeJoin: round 有足够空间画出圆弧
      // 4. scale 调小补偿粗描边带来的视觉膨胀
      $(go.Shape, {
        toArrow: this.linkConfig.arrowType,
        scale: this.linkConfig.arrowScale,
        strokeWidth: this.linkConfig.arrowStrokeWidth,
        strokeCap: "round",
        strokeJoin: "round",                  // 关键：让箭头三角顶点变圆润
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      },
        // 箭头填充色
        new go.Binding("fill", "", (data: go.ObjectData) => {
          if (data.isCrossTree) return styles.link.crossTreeColor;
          return (data.familyColor as string) || styles.link.parentChildColor;
        }),
        // 箭头描边色 - 必须与 fill 一致才能形成完整的圆角填充效果
        new go.Binding("stroke", "", (data: go.ObjectData) => {
          if (data.isCrossTree) return styles.link.crossTreeColor;
          return (data.familyColor as string) || styles.link.parentChildColor;
        }))
    ];
  }

  /**
   * 获取联系块标签配置
   */
  getConnectionLabelConfig($: typeof go.GraphObject.make): go.Panel {
    return $(go.Panel, "Auto", {
      segmentIndex: NaN,
      segmentFraction: 0.5,
      cursor: "pointer"
    },
      new go.Binding("visible", "isCrossTree"),
      $(go.Shape, "RoundedRectangle", {
        fill: "#f5f3ff",
        stroke: "#8b5cf6",
        strokeWidth: 1,
        parameter1: 4
      }),
      $(go.Panel, "Horizontal",
        { margin: 3, defaultAlignment: go.Spot.Center },
        $(go.TextBlock, "🔗", { font: "8px 'LXGW WenKai Screen', sans-serif" }),
        $(go.TextBlock, {
          font: "500 8px 'LXGW WenKai Screen', sans-serif",
          stroke: "#6d28d9",
          maxSize: new go.Size(50, 14),
          overflow: go.TextBlock.OverflowEllipsis,
          margin: new go.Margin(0, 0, 0, 2)
        },
          new go.Binding("text", "description", (desc: string) => desc ? desc.substring(0, 6) : "..."))
      ));
  }
}
