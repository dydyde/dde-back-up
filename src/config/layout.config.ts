// ============================================
// 布局配置
// 包含流程图布局、GoJS 配置、坐标系统相关常量
// ============================================

/**
 * 布局配置
 */
export const LAYOUT_CONFIG = {
  /** 阶段间水平间距 */
  STAGE_SPACING: 260,
  /** 任务行垂直间距 */
  ROW_SPACING: 140,
  /** 自动布局中家族之间的基础额外留白（按行高倍数） */
  AUTO_LAYOUT_FAMILY_GAP_ROWS: 0.12,
  /** 兄弟子树之间的基础额外留白（按行高倍数） */
  AUTO_LAYOUT_SIBLING_GAP_ROWS: 0.04,
  /** 跨树链接块对家族间距施加的额外压力（按行高倍数）
   * 【2026-04-22】从 0.24 提升到 0.40：关联块（跨树连线中点标签）以往
   * 因为压力上限过低而在视觉上重叠，抬高基础压力并配合 stage-pair 拥挤度
   * 放大，是解决"排序后关联块重叠严重"的第一环。 */
  AUTO_LAYOUT_CROSS_TREE_LABEL_GAP_ROWS: 0.40,
  /** 兄弟子树存在外部联系时附加的留白系数（按行高倍数）
   * 【2026-04-22】从 0.06 提升到 0.12：让含有多条跨树链接的兄弟子树获得
   * 更明显的纵向呼吸空间，避免它们的关联块堆叠在同一 Y 带。 */
  AUTO_LAYOUT_RELATED_SIBLING_GAP_ROWS: 0.12,
  /** 高密度家族相邻时额外增加的留白系数（按行高倍数） */
  AUTO_LAYOUT_DENSE_FAMILY_GAP_ROWS: 0.04,
  /** 多父/多来源子树相邻时的额外留白系数（按行高倍数） */
  AUTO_LAYOUT_MULTI_PARENT_SIBLING_GAP_ROWS: 0.05,
  /** 家族间额外间距硬上限（按行高倍数），防止大型复杂场景下间距失控
   * 【2026-04-22】从 0.35 提升到 0.80：配合关联块拥挤度加权，允许压力
   * 上升到真正能分离标签的程度；实测 10+ 跨树链接家族组合下仍在一屏内。 */
  AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS: 0.80,
  /** 兄弟子树间额外留白硬上限（按行高倍数）
   * 【2026-04-22】从 0.22 提升到 0.45：兄弟关系载荷大时允许更明显的分离。 */
  AUTO_LAYOUT_MAX_SIBLING_GAP_ROWS: 0.45,
  /** 高密度阶段边界的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_DENSITY_GAP_FACTOR: 0.03,
  /** 父子扇出较多时的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_LINK_GAP_FACTOR: 0.035,
  /** 跨树连接穿过阶段边界时的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_CROSS_TREE_GAP_FACTOR: 0.025,
  /**
   * 多父扇入（shared-grandchild 等）穿过阶段边界时的额外横向留白系数。
   * 场景：两个父候选 -> 同一子节点，视觉上表现为多对一合流；此时在
   * 父 stage -> 子 stage 之间的列距拉宽，能让合流连线获得呼吸感，
   * 避免被相邻的普通父子连线挤压成交叉黑块。
   */
  AUTO_LAYOUT_STAGE_MULTI_PARENT_GAP_FACTOR: 0.03,
  /** 阶段边界额外横向留白硬上限（相对 stage spacing） */
  AUTO_LAYOUT_MAX_STAGE_EXTRA_FACTOR: 0.18,
  /**
   * 家族重排 2-opt 的最大迭代次数（按家族数 n 的倍数）。
   * 每次 2-opt pass 是 O(n²)，总复杂度被 n * n² = n³ 上限锁住，避免极端
   * 大项目下的布局卡顿。实测 n ≤ 40 时 2-opt 用时 < 2ms。
   */
  AUTO_LAYOUT_TWO_OPT_MAX_PASSES: 4,
  /**
   * 2-opt 的改进容忍阈值：只有当候选排列的加权跨距至少减少这个值才接受。
   * 防止浮点噪声下的无限循环；单位与跨距权重一致（affinity * |Δpos|）。
   */
  AUTO_LAYOUT_TWO_OPT_IMPROVEMENT_EPSILON: 0.5,
  /**
   * 【补丁 A 2026-04-23】是否启用 GoJS AvoidsLinksRouter（vendored）。
   * 作用：对 isOrthogonal 的 link 自动分离重叠的并行段，降低线条"挤成一坨"的视觉混乱。
   * 重要：router 仅对 `link.isOrthogonal === true` 的连线生效（源码 isRoutable 校验）。
   * 【2026-04-23 补丁 E】cross-tree link 已切为 go.Link.Orthogonal，本开关默认 true。
   */
  AUTO_LAYOUT_ENABLE_AVOIDS_LINKS_ROUTER: true,
  /**
   * 【补丁 A 2026-04-23】AvoidsLinksRouter 的 linkSpacing（像素）。
   * 并行段之间的目标间距，若 avoidsNodes=true 则是最大允许距离。
   * GoJS 默认 4；对于本项目 140px ROW_SPACING、11px label 场景，6-8px 较合适。
   */
  AUTO_LAYOUT_ROUTER_LINK_SPACING_PX: 8,
  /**
   * 【补丁 B 2026-04-23】是否在兄弟排序阶段启用局部 2-opt 交换优化。
   * 在 barycenter sweep 之后对每对相邻兄弟子树做一次 swap 评估：
   * 只要交换后 |pos - relationCenter| 之和严格更小就接受，
   * 不引入 rank 倒置，保持业务顺序。pass 复杂度 O(k²)，k 为同父兄弟数。
   */
  AUTO_LAYOUT_ENABLE_SIBLING_TWO_OPT: true,
  /**
   * 【补丁 C 2026-04-23 / v2 调参 14:50】关联块（cross-tree link label）沿线错开步长。
   * 同一 stage-pair 内每条链接占 segmentFraction 一档。默认 0.22，多条链接时
   * clamp 到 [0.08, 0.92]；补丁 F 边界分配算法内还会按此值做桶内微抖动。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_FRACTION_STEP: 0.22,
  /**
   * 关联块默认落点：从 source 指向 target 的连线长度约 2/3 处，
   * 也就是更靠近被关联目标端的 1/3 区域，避免压在连线正中遮挡走势。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION: 2 / 3,
  /**
   * 【补丁 C 2026-04-23 / v2 调参 14:50】关联块垂直方向额外错开（像素/档）。
   * 解决短连线上多 label 时 fraction 距离不够的场景；与 fraction 双重保证可读。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_OFFSET_PX: 22,
  /**
   * 【补丁 D 2026-04-23 / v2 调参 14:50】按关联块密度动态扩展 stage 列间距的
   * 绝对像素基数。每增加一条同边界的 cross-tree link，按 sqrt(N-1) 放大加宽。
   * 默认 48（原 40）；0 表示关闭。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_DENSITY_WIDEN_PX: 48,
  /**
   * 【补丁 G 2026-04-23 14:55 / v2 14:56】node-label 重叠二次避让触发阈值。
   * v2 下调：4 → 3，让中等密度也能触发放大。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_THRESHOLD: 3,
  /**
   * 【补丁 G 2026-04-23 14:55 / v2 14:56】密集区的垂直偏移放大倍数。
   * v2 上调：1.6 → 1.9。22px * 1.9 ≈ 42px/档，越过典型节点高度。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_DENSE_STAGE_VERTICAL_BOOST: 1.9,
  /**
   * 【补丁 H 2026-04-23 14:57】关联块文本最大显示字符数。
   * 超出则显示 "…"。关联块过宽会占用 stage 列宽，加剧拥挤。
   * 桌面 / 移动端可同用此值；tooltip 和点击编辑仍展示完整内容。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_TEXT_MAX_CHARS: 12,
  /**
   * 【补丁 H 2026-04-23 14:57】关联块渲染最大宽度（像素）。
   * OverflowEllipsis 裁剪；实际宽度不会超过此值。
   */
  AUTO_LAYOUT_CROSS_TREE_LABEL_MAX_WIDTH_PX: 88,
  /** 根任务基础 rank 值 */
  RANK_ROOT_BASE: 10000,
  /** rank 步进值 */
  RANK_STEP: 500,
  /** rank 最小间隔 */
  RANK_MIN_GAP: 50,
  /** 默认任务 X 坐标 */
  DEFAULT_TASK_X: 300,
} as const;

/**
 * 浮动任务树配置
 * 支持待分配区构建任务树结构
 */
export const FLOATING_TREE_CONFIG = {
  /** 阶段缓冲区大小：允许的最大阶段 = 当前最大阶段 + STAGE_BUFFER */
  STAGE_BUFFER: 10,
  /** 子树最大深度（防止无限递归） */
  MAX_SUBTREE_DEPTH: 100,
} as const;

/**
 * GoJS 流程图配置
 */
export const GOJS_CONFIG = {
  /** 自动布局层间距 */
  LAYER_SPACING: 100,
  /** 自动布局列间距 */
  COLUMN_SPACING: 40,
  /** 滚动边距 */
  SCROLL_MARGIN: 100,
  /** 待分配节点宽度 */
  UNASSIGNED_NODE_WIDTH: 140,
  /** 已分配节点宽度 */
  ASSIGNED_NODE_WIDTH: 200,
  /** 连接线捕获阈值（像素） */
  LINK_CAPTURE_THRESHOLD: 120,
  /** 端口大小（已废弃，保留向后兼容） */
  PORT_SIZE: 10,
  /** 端口触控热区厚度 - 桌面端 */
  PORT_HITAREA_DESKTOP: 10,
  /** 端口触控热区厚度 - 移动端 */
  PORT_HITAREA_MOBILE: 16,
  /** 端口高亮条视觉厚度 */
  PORT_VISUAL_HIGHLIGHT: 4,
  /** 端口角落内缩距离（解决角落重叠） */
  PORT_CORNER_INSET: 2,
  /** 连接线端点最小线段长度 */
  LINK_END_SEGMENT_LENGTH: 22,
  /** 端口高亮颜色（主题色 indigo 半透明） */
  PORT_HIGHLIGHT_COLOR: 'rgba(99, 102, 241, 0.25)',
  /** 端口高亮动画过渡时间（毫秒） */
  PORT_HIGHLIGHT_TRANSITION_MS: 150,
  /** 位置保存防抖延迟（毫秒） */
  POSITION_SAVE_DEBOUNCE: 300,
  /** 详情面板默认右边距 */
  DETAIL_PANEL_RIGHT_MARGIN: 8,
  /** 详情面板宽度（w-64 = 256px） */
  DETAIL_PANEL_WIDTH: 256,
  /** SSR 默认窗口高度 */
  SSR_DEFAULT_HEIGHT: 800,
} as const;

/**
 * 字母表（用于 displayId 生成）
 */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 上标数字映射
 */
export const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
};
