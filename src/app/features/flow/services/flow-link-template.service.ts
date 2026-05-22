/**
 * FlowLinkTemplateService - GoJS 连接线模板配置
 * 
 * 从 FlowTemplateService 提取的连接线相关逻辑
 * 
 * 职责：
 * - 连接线模板配置（样式、标签、工具）
 * - LinkingTool / RelinkingTool 配置
 * - 周界交点计算算法（用于连接线端点定位）
 * - Overview 连接线模板
 */

import { Injectable, inject } from '@angular/core';
import { GOJS_CONFIG } from '../../../../config';
import { LAYOUT_CONFIG } from '../../../../config/layout.config';
import { getFlowStyles, FlowTheme, FlowColorMode } from '../../../../config/flow-styles';
import { flowTemplateEventHandlers } from './flow-template-events';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import * as go from 'gojs';
import {
  GojsClickHandler,
  GojsNodeExt,
  GojsGraphObjectExt,
  GojsLinkingToolExt,
  GojsRelinkingToolExt,
  GojsMake,
  LinkStyleConfig,
} from './flow-template.types';
import { FlowRelinkToolService } from './flow-relink-tool.service';

@Injectable({
  providedIn: 'root'
})
export class FlowLinkTemplateService {
  private readonly uiState = inject(UiStateService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLinkTemplate');
  private readonly themeService = inject(ThemeService);
  private readonly relinkToolService = inject(FlowRelinkToolService);

  // ========== 主题感知的样式获取 ==========

  /**
   * 获取当前主题的 GoJS 样式配置
   */
  private getCurrentFlowStyles() {
    const theme = this.themeService.theme() as FlowTheme;
    const colorMode: FlowColorMode = this.themeService.isDark() ? 'dark' : 'light';
    return getFlowStyles(theme, colorMode);
  }

  // ========== 样式配置 ==========

  getLinkStyleConfig(isMobile: boolean): LinkStyleConfig {
    const flowStyles = this.getCurrentFlowStyles();
    const rawCaptureRadius = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD ?? 80;
    const captureRadius = isMobile
      ? Math.min(Math.max(rawCaptureRadius, 28), 60)
      : Math.min(Math.max(rawCaptureRadius, 16), 36);
    
    return {
      defaultStroke: flowStyles.link.parentChildColor,
      parentChildStroke: flowStyles.link.parentChildColor,
      selectedStroke: flowStyles.node.selectedBorder,
      strokeWidth: 1.5,
      captureRadius
    };
  }

  getLinkCurveConfig(): { curve: typeof go.Link.Bezier; curviness: number } {
    return {
      curve: go.Link.Bezier,
      curviness: 20
    };
  }

  // ========== Perimeter Intersection 算法 ==========

  /**
   * 计算从节点中心到目标点的射线与节点边界的交点
   * 效果：连接线端点像水珠一样沿着节点边缘滑动
   */
  computePerimeterIntersection(bounds: go.Rect, targetPoint: go.Point): go.Point {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    
    const dx = targetPoint.x - centerX;
    const dy = targetPoint.y - centerY;
    
    if (dx === 0 && dy === 0) {
      return new go.Point(centerX, bounds.y);
    }
    
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    
    let t = Infinity;
    
    if (dx > 0) {
      const tRight = halfWidth / dx;
      if (tRight < t && Math.abs(dy * tRight) <= halfHeight) {
        t = tRight;
      }
    }
    
    if (dx < 0) {
      const tLeft = -halfWidth / dx;
      if (tLeft < t && Math.abs(dy * tLeft) <= halfHeight) {
        t = tLeft;
      }
    }
    
    if (dy > 0) {
      const tBottom = halfHeight / dy;
      if (tBottom < t && Math.abs(dx * tBottom) <= halfWidth) {
        t = tBottom;
      }
    }
    
    if (dy < 0) {
      const tTop = -halfHeight / dy;
      if (tTop < t && Math.abs(dx * tTop) <= halfWidth) {
        t = tTop;
      }
    }
    
    if (t === Infinity) {
      return new go.Point(centerX, bounds.y);
    }
    
    return new go.Point(centerX + dx * t, centerY + dy * t);
  }

  /**
   * 计算节点边界交点（从节点获取）
   */
  computeNodeEdgePoint(node: go.Node, targetPoint: go.Point): go.Point {
    const bodyPanel = node.findObject("BODY") as go.Panel;
    let bounds: go.Rect;
    
    if (bodyPanel) {
      bounds = bodyPanel.getDocumentBounds();
    } else {
      bounds = node.actualBounds;
      if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
        return node.getDocumentPoint(go.Spot.Center);
      }
      const loc = node.location;
      bounds = new go.Rect(
        loc.x - bounds.width / 2,
        loc.y - bounds.height / 2,
        bounds.width,
        bounds.height
      );
    }
    
    if (!bounds.isReal()) {
      return node.getDocumentPoint(go.Spot.Center);
    }
    
    return this.computePerimeterIntersection(bounds, targetPoint);
  }

  // ========== 连接线模板 ==========

  /**
   * 设置连接线模板
   * 
   * 包括：
   * - LinkingTool/RelinkingTool 配置
   * - 临时连接线样式
   * - 永久连接线模板
   * - 跨树连接标签面板
   */
  setupLinkTemplate(diagram: go.Diagram): void {
    const $ = go.GraphObject.make;
    const isMobile = this.uiState.isMobile();
    const allowedPortIds = ["T", "B", "L", "R"];
    const linkStyleConfig = this.getLinkStyleConfig(isMobile);
    const pointerTolerance = isMobile ? 6 : 3;
    
    // 创建 getLinkPoint 函数
    const freeAngleLinkPoint = this.createGetLinkPointFunction(diagram, allowedPortIds);
    
    // 配置 LinkingTool
    this.configureLinkingTool(diagram, allowedPortIds, freeAngleLinkPoint, $);
    
    // 配置 RelinkingTool
    this.relinkToolService.configureRelinkingTool(diagram, allowedPortIds, linkStyleConfig, freeAngleLinkPoint, pointerTolerance, $);
    
    // 创建连接线模板
    diagram.linkTemplate = $(go.Link,
      {
        layerName: 'Links',
        routing: go.Link.Normal,
        curve: go.Link.Bezier,
        getLinkPoint: freeAngleLinkPoint,
        toShortLength: this.configService.linkConfig.toShortLength,
        fromEndSegmentLength: 22,
        toEndSegmentLength: 22,
        selectable: true,
        selectionAdorned: true,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: true,
        resegmentable: false,
        // 【修复】移动端不设置 click，事件由 ObjectSingleClicked 处理
        // 桌面端通过 click 事件处理
        ...(isMobile ? {} : {
          click: ((e: go.InputEvent, link: go.GraphObject) => {
            if (e.handled) return;
            e.handled = true;
            flowTemplateEventHandlers.onLinkClick?.(link as go.Link);
          }) as GojsClickHandler
        }),
        contextMenu: $(go.Adornment, "Vertical",
          $("ContextMenuButton",
            $(go.TextBlock, "删除连接", { margin: 5 }),
            {
              click: ((e: go.InputEvent, obj: go.GraphObject) => {
                const link = (obj.part as go.Adornment)?.adornedPart;
                if ((link as go.Link)?.data) {
                  flowTemplateEventHandlers.onLinkDeleteRequest?.(link as go.Link);
                }
              }) as GojsClickHandler
            }
          )
        )
      },
      // 【2026-02-25 性能优化】默认模板不含 label panel（仅用于父子链接）
      // 跨树链接使用 'crossTree' category 模板，含 label panel + tooltip
      ...this.configService.getLinkMainShapesConfig($, isMobile)
    );
    
    // 【2026-02-25 性能优化】跨树链接专用模板——包含 label panel + tooltip
    // 父子链接（占大多数）不再承载隐藏的 label panel，每条节省 ~6 个 GraphObject
    // 【2026-04-23 回退】按用户要求把跨树连线从 Orthogonal 正交段回退为 Bezier 曲线，
    // 与历史视觉一致；关联块改由默认 segmentFraction=0.5 居中嵌入曲线中段。
    const crossTreeLinkTemplate = $(go.Link,
      {
        layerName: 'Links',
        routing: go.Link.Normal,
        curve: go.Link.Bezier,
        getLinkPoint: freeAngleLinkPoint,
        toShortLength: this.configService.linkConfig.toShortLength,
        fromEndSegmentLength: 22,
        toEndSegmentLength: 22,
        selectable: true,
        selectionAdorned: true,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: true,
        resegmentable: false,
        // 【修复】移动端不设置 click，让点击事件能传递到关联块标签
        // 桌面端通过 click 事件处理
        ...(isMobile ? {} : {
          click: ((e: go.InputEvent, link: go.GraphObject) => {
            if (e.handled) return;
            e.handled = true;
            flowTemplateEventHandlers.onLinkClick?.(link as go.Link);
          }) as GojsClickHandler
        }),
        contextMenu: $(go.Adornment, "Vertical",
          $("ContextMenuButton",
            $(go.TextBlock, "删除连接", { margin: 5 }),
            {
              click: ((e: go.InputEvent, obj: go.GraphObject) => {
                const link = (obj.part as go.Adornment)?.adornedPart;
                if ((link as go.Link)?.data) {
                  flowTemplateEventHandlers.onLinkDeleteRequest?.(link as go.Link);
                }
              }) as GojsClickHandler
            }
          )
        )
      },
      ...this.configService.getLinkMainShapesConfig($, isMobile),
      this.createConnectionLabelPanel($)
    );
    diagram.linkTemplateMap.add('crossTree', crossTreeLinkTemplate);
    
    this.logger.debug('连接线模板已设置（含 crossTree 分类模板）');
  }

  /**
   * 创建 getLinkPoint 函数
   */
  private createGetLinkPointFunction(
    _diagram: go.Diagram,
    _allowedPortIds: string[]
  ): go.Link['getLinkPoint'] {
    const self = this;
    
    return function(this: go.Link, node, port, spot, from, _ortho, otherNode, otherPort) {
      let actualNode: go.Node | null = null;
      
      // 【2026-02-25 性能优化】快速路径——绝大多数正常渲染场景下 fromNode/toNode 有效
      // 直接取用并跳过后续 3 个 fallback 策略，避免 findObject('BODY') 等 O(子节点数) 查找
      // 仅在 fromNode/toNode 为 null（linking/relinking 工具活跃时）才走 fallback
      if (from) {
        if (this.fromNode?.data) {
          actualNode = this.fromNode;
        }
      } else {
        if (this.toNode?.data) {
          actualNode = this.toNode;
        }
      }
      
      // 快速路径命中——跳过策略 2/3/4
      if (actualNode) {
        const doc = actualNode.diagram;
        const target = otherPort?.getDocumentPoint(go.Spot.Center)
          || otherNode?.getDocumentPoint(go.Spot.Center)
          || doc?.lastInput?.documentPoint
          || actualNode.getDocumentPoint(go.Spot.Center);
        
        return self.computeNodeEdgePoint(actualNode, target);
      }
      
      // ——以下为 fallback 路径（仅在 linking/relinking 工具活跃或异常场景时执行）——
      
      // 策略2: 使用传入的 node 参数
      if (!actualNode && node instanceof go.Node) {
        const nodeExt = node as go.Node & GojsNodeExt;
        const hasData = !!nodeExt.data;
        const hasBody = !!nodeExt.findObject?.('BODY');
        if (hasData || hasBody) {
          actualNode = node;
        }
      }
      
      // 策略3: 从 port.part 获取
      if (!actualNode && port) {
        const portExt = port as go.GraphObject & GojsGraphObjectExt;
        if (portExt.part instanceof go.Node) {
          const partNode = portExt.part;
          const nodeExt = partNode as go.Node & GojsNodeExt;
          const hasData = !!nodeExt.data;
          const hasBody = !!nodeExt.findObject?.('BODY');
          if (hasData || hasBody) {
            actualNode = partNode;
          }
        }
      }
      
      // 策略4: 从工具状态获取
      if (!actualNode && this.diagram) {
        const linkingTool = this.diagram.toolManager.linkingTool;
        const relinkingTool = this.diagram.toolManager.relinkingTool;
        
        if (linkingTool.isActive) {
          const linkToolExt = linkingTool as go.LinkingTool & GojsLinkingToolExt;
          const originalPort = from 
            ? (linkToolExt.originalFromPort || linkToolExt._tempMainPort)
            : linkToolExt.originalToPort;
          
          if (typeof originalPort === 'string') {
            actualNode = this.diagram.findNodeForKey(originalPort);
          } else if (originalPort && (originalPort as go.GraphObject).part instanceof go.Node) {
            actualNode = (originalPort as go.GraphObject).part as go.Node;
          }
        }
        
        if (!actualNode && relinkingTool.isActive) {
          const relinkToolExt = relinkingTool as go.RelinkingTool & GojsRelinkingToolExt;
          let adornedLink = relinkToolExt.adornedLink || 
                           relinkToolExt.adornedObject ||
                           relinkToolExt.originalLink;
          
          if (!adornedLink && this.diagram.selection) {
            this.diagram.selection.each((part: go.Part) => {
              if (part instanceof go.Link && !adornedLink) {
                adornedLink = part;
              }
            });
          }
          
          if (adornedLink instanceof go.Link) {
            const isRelinkingFrom = relinkToolExt.isForwards === false;
            const isRelinkingTo = relinkToolExt.isForwards === true;
            
            if (from) {
              if (!isRelinkingFrom) {
                actualNode = adornedLink.fromNode;
              }
            } else {
              if (!isRelinkingTo) {
                actualNode = adornedLink.toNode;
              }
            }
          }
        }
      }
      
      if (!actualNode) {
        if (this.diagram?.lastInput?.documentPoint) {
          return this.diagram.lastInput.documentPoint;
        }
        return new go.Point();
      }
      
      const doc = actualNode.diagram;
      const target = otherPort?.getDocumentPoint(go.Spot.Center)
        || otherNode?.getDocumentPoint(go.Spot.Center)
        || doc?.lastInput?.documentPoint
        || actualNode.getDocumentPoint(go.Spot.Center);
      
      return self.computeNodeEdgePoint(actualNode, target);
    };
  }

  /**
   * 配置 LinkingTool
   */
  private configureLinkingTool(
    diagram: go.Diagram,
    allowedPortIds: string[],
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    $: GojsMake
  ): void {
    const linkingTool = diagram.toolManager.linkingTool;
    
    // 只允许从边缘端口开始拉线
    const originalCanStart = linkingTool.canStart;
    linkingTool.canStart = function() {
      if (!originalCanStart.call(this)) return false;
      const dia = this.diagram;
      if (!dia) return false;
      const input = dia.lastInput;
      if (!input) return false;
      const port = dia.findObjectAt(input.documentPoint, (obj: go.GraphObject | null) => {
        if (obj && typeof (obj as go.GraphObject & { portId?: string }).portId === "string") {
          const portId = (obj as go.GraphObject & { portId: string }).portId;
          if (portId.length > 0 && allowedPortIds.includes(portId)) {
            return obj;
          }
        }
        return null;
      }, null) as go.GraphObject & { portId?: string } | null;
      if (!port || !port.portId) return false;
      return allowedPortIds.includes(port.portId);
    };

    const findEdgePortAtPointer = (tool: go.LinkingTool): (go.GraphObject & { portId?: string }) | null => {
      const dia = tool.diagram;
      const input = dia?.lastInput;
      if (!dia || !input) return null;

      return dia.findObjectAt(input.documentPoint, (obj: go.GraphObject | null) => {
        if (obj && typeof (obj as go.GraphObject & { portId?: string }).portId === 'string') {
          const portId = (obj as go.GraphObject & { portId: string }).portId;
          if (portId.length > 0 && allowedPortIds.includes(portId)) {
            return obj;
          }
        }
        return null;
      }, null) as (go.GraphObject & { portId?: string }) | null;
    };
    
    // 偷梁换柱：激活后替换为主节点端口
    const originalDoActivate = linkingTool.doActivate;
    linkingTool.doActivate = function() {
      originalDoActivate.call(this);
      
      const toolExt = this as go.LinkingTool & GojsLinkingToolExt;
      const pointerPort = findEdgePortAtPointer(this);
      const startPort = pointerPort
        || toolExt.startPort 
        || toolExt.originalFromPort 
        || toolExt.fromPort;
      
      let edgePortObj: (go.GraphObject & { portId?: string }) | null = null;
      
      if (pointerPort) {
        edgePortObj = pointerPort;
      } else if (startPort && typeof startPort === 'object' && (startPort as go.GraphObject & { portId?: string }).portId) {
        edgePortObj = startPort as go.GraphObject & { portId?: string };
      } else if (startPort && typeof startPort === 'string' && allowedPortIds.includes(startPort)) {
        const originalNode = toolExt.originalFromNode || toolExt.fromNode;
        if (originalNode instanceof go.Node) {
          edgePortObj = originalNode.findPort(startPort) as (go.GraphObject & { portId?: string }) | null;
        }
      }
      
      if (edgePortObj && edgePortObj.portId && allowedPortIds.includes(edgePortObj.portId)) {
        const node = edgePortObj.part;
        if (node instanceof go.Node) {
          toolExt._originNode = node;
          const mainPort = node.findPort("");
          if (mainPort) {
            toolExt._tempMainPort = mainPort;
            toolExt._savedFromLinkable = mainPort.fromLinkable ?? false;
            toolExt._savedToLinkable = mainPort.toLinkable ?? false;
            
            mainPort.fromLinkable = true;
            
            toolExt.startPort = mainPort;
            toolExt.originalFromPort = mainPort;
            toolExt.fromPort = mainPort;
            
            if (this.temporaryLink) {
              (this.temporaryLink as go.Link & { fromNode?: go.Node }).fromNode = node;
              this.temporaryLink.fromPortId = "";
              this.temporaryLink.fromSpot = go.Spot.AllSides;
              this.temporaryLink.toSpot = go.Spot.AllSides;
              this.temporaryLink.invalidateRoute();
            }
          }
        }
      }
    };

    // 恢复主节点端口状态
    const originalDoDeactivate = linkingTool.doDeactivate;
    linkingTool.doDeactivate = function() {
      const toolExt = this as go.LinkingTool & GojsLinkingToolExt;
      const mainPort = toolExt._tempMainPort;
      if (mainPort) {
        (mainPort as go.GraphObject).fromLinkable = toolExt._savedFromLinkable ?? false;
        (mainPort as go.GraphObject).toLinkable = toolExt._savedToLinkable ?? false;
        toolExt._tempMainPort = null;
      }
      originalDoDeactivate.call(this);
      toolExt._originNode = null;
      toolExt.startPort = null;
      toolExt.fromPort = null;
      toolExt.originalFromPort = null;
      toolExt._savedFromLinkable = undefined;
      toolExt._savedToLinkable = undefined;
    };
    
    // 禁止自连接
    const originalIsValidLink = linkingTool.isValidLink;
    linkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      if (fromNode === toNode) return false;
      return originalIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };
    
    // 配置临时连接线
    linkingTool.temporaryLink = $(go.Link,
      { 
        layerName: "Tool", 
        getLinkPoint: freeAngleLinkPoint,
        curve: go.Link.Bezier
      },
      $(go.Shape, { 
        stroke: "#78716C", 
        strokeWidth: 6, 
        strokeDashArray: [4, 4],
        strokeCap: "round",
        strokeJoin: "round"
      }),
      $(go.Shape, { 
        toArrow: "Standard",
        fill: "#78716C",
        stroke: "#78716C",
        strokeWidth: 7,
        strokeCap: "round",
        strokeJoin: "round",
        scale: 0.9,
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      })
    ) as go.Link;
    
    (linkingTool as go.LinkingTool & { temporaryFromSpot?: go.Spot }).temporaryFromSpot = go.Spot.AllSides;
    (linkingTool as go.LinkingTool & { temporaryToSpot?: go.Spot }).temporaryToSpot = go.Spot.AllSides;
  }

  /**
   * 创建跨树连接标签面板
   * 
   * 设计说明（类似维基百科悬浮预览）：
   * - 默认只显示标题（title）或截断的描述
   * - 鼠标悬停时只显示描述内容（不含标题）
   * - 悬停提示位置自动适应，避免遮挡节点
   * - 点击时打开完整编辑器
   */
  private createConnectionLabelPanel($: GojsMake): go.Panel {
    const isMobile = this.uiState.isMobile();
    
    // 创建悬停提示（仅桌面端，移动端不显示 tooltip）
    // 智能定位：基于连接线角度决定 Tooltip 位置（O(1) 操作，无节点遍历）
    const createTooltip = () => {
      return $(go.Adornment, "Auto",
        {
          background: null,
          isShadowed: true,
          shadowOffset: new go.Point(0, 2),
          shadowColor: "rgba(0, 0, 0, 0.12)"
        },
        // 基于连接线角度智能定位 Tooltip
        // - 水平连接线（0-45° 或 135-180°）：Tooltip 向上偏移
        // - 垂直连接线（45-135°）：Tooltip 向右偏移
        new go.Binding("segmentOffset", "", (_data: unknown, obj: go.GraphObject) => {
          const adornment = obj.part;
          if (!adornment || !(adornment instanceof go.Adornment)) {
            return new go.Point(0, -25);
          }
          const link = adornment.adornedPart;
          if (!link || !(link instanceof go.Link)) {
            return new go.Point(0, -25);
          }
          // 获取连接线中点角度（O(1) 几何计算）
          const midAngle = link.midAngle;
          // 归一化到 0-180° 简化判断
          const normalized = Math.abs(midAngle % 180);
          
          if (normalized > 45 && normalized < 135) {
            // 垂直连接线 → 向右偏移，避免遮挡节点
            return new go.Point(25, 0);
          } else {
            // 水平连接线 → 向上偏移
            return new go.Point(0, -25);
          }
        }).ofObject(),
        $(go.Shape, "RoundedRectangle", {
          fill: "rgba(255, 255, 255, 0.98)",
          stroke: "#a78bfa",
          strokeWidth: 1,
          parameter1: 5
        }),
        $(go.TextBlock, {
          font: "10px \"LXGW WenKai Screen\", sans-serif",
          stroke: "#525252",
          margin: 8,
          maxSize: new go.Size(180, 120),
          overflow: go.TextBlock.OverflowEllipsis,
          wrap: go.TextBlock.WrapFit
        },
        new go.Binding("text", "description", (desc: string) => desc || "暂无描述"))
      );
    };
    
    // 构建面板配置对象，只在桌面端添加 toolTip 属性
    const panelConfig: Partial<go.Panel> & { toolTip?: go.Adornment } = {
      segmentIndex: NaN,
      segmentFraction: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
      cursor: "pointer",
      background: "transparent",
    };
    
    // 只在非移动端设置 toolTip，避免 GoJS 验证错误
    if (!isMobile) {
      panelConfig.toolTip = createTooltip();
    }
    
    return $(go.Panel, "Auto",
      {
        ...panelConfig,
        // 默认仍贴在线中段；当布局层为特定 cross-tree link 计算出错开位时，
        // 由下面的 binding 覆盖默认 segmentFraction / segmentOffset。
      },
      new go.Binding(
        "segmentFraction",
        "labelSegmentFraction",
        (fraction: number | undefined) => typeof fraction === 'number'
          ? fraction
          : LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
      ),
      new go.Binding(
        "segmentOffset",
        "labelSegmentOffsetY",
        (offsetY: number | undefined) => new go.Point(0, typeof offsetY === 'number' ? offsetY : 0),
      ),
      // 桌面端保留标签点击直达编辑；移动端交由 ObjectSingleClicked 统一处理
      {
        ...(isMobile ? {} : {
          click: (e: go.InputEvent, obj: go.GraphObject) => {
            const link = obj?.part as go.Link | undefined;
            if (!link?.data?.isCrossTree) return;
            e.handled = true;

            const diagram = e.diagram;
            let viewX = 0;
            let viewY = 0;

            if (diagram && link) {
              const labelPoint = obj.getDocumentPoint(go.Spot.Center);
              if (labelPoint && isFinite(labelPoint.x) && isFinite(labelPoint.y)) {
                const viewPoint = diagram.transformDocToView(labelPoint);
                viewX = viewPoint.x;
                viewY = viewPoint.y;
              } else {
                // 降级：使用点击位置
                viewX = e.viewPoint?.x ?? 0;
                viewY = e.viewPoint?.y ?? 0;
              }
            } else {
              // 降级：使用点击位置
              viewX = e.viewPoint?.x ?? 0;
              viewY = e.viewPoint?.y ?? 0;
            }

            flowTemplateEventHandlers.onCrossTreeLabelClick?.(link, viewX, viewY);
          }
        })
      },
      // 【2026-02-25 性能优化】不再需要 visible 绑定——此 panel 仅在 crossTree 模板中使用
      // new go.Binding("visible", "isCrossTree"), // 已由模板分类取代
      $(go.Shape, "RoundedRectangle", {
        fill: "#f5f3ff",
        stroke: "#8b5cf6",
        strokeWidth: 1,
        parameter1: 4,
        ...(isMobile ? { minSize: new go.Size(44, 24) } : {}),
        cursor: "pointer"
      }),
      $(go.Panel, "Horizontal",
        { margin: isMobile ? 6 : 3, defaultAlignment: go.Spot.Center, cursor: "pointer" },
        $(go.TextBlock, "🔗", { 
          font: `${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`, 
          cursor: "pointer"
        }),
        $(go.TextBlock, {
          font: `500 ${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`,
          stroke: "#6d28d9",
          // 【补丁 H 2026-04-23 14:57】宽度收紧到 LAYOUT_CONFIG，配合字符截断
          maxSize: new go.Size(
            isMobile
              ? Math.min(100, LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_MAX_WIDTH_PX + 12)
              : LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_MAX_WIDTH_PX,
            14,
          ),
          overflow: go.TextBlock.OverflowEllipsis,
          margin: new go.Margin(0, 0, 0, 2),
          cursor: "pointer"
        },
        // 【补丁 H 2026-04-23 14:57】关联块显示文本截断：
        // 过长 title/description 会撑宽 label panel，加剧横向拥挤，
        // 因此在渲染端强制收窄。完整文本仍保留在数据 / tooltip / 编辑弹窗。
        new go.Binding("text", "", (data: go.ObjectData) => {
          const d = data as { title?: string; description?: string };
          const maxChars = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TEXT_MAX_CHARS;
          const raw = d.title?.trim() || d.description?.trim() || "";
          if (!raw) return "...";
          // 中英混排近似字符宽度一致，用 Array.from 处理 emoji / 代理对
          const chars = Array.from(raw);
          return chars.length <= maxChars ? raw : chars.slice(0, maxChars).join("") + "…";
        }))
      )
    );
  }

  // ========== Overview 连接线模板 ==========

  /**
   * 设置 Overview 连接线模板（简化版 - 性能优化）
   * 
   * 关键优化：
   * 1. 使用直线而非曲线：减少计算开销
   * 2. 去掉颜色绑定：使用固定颜色
   */
  setupOverviewLinkTemplate(overview: go.Overview): void {
    const $ = go.GraphObject.make;
    const styles = this.configService.currentStyles();
    
    // 简化的连接线模板 - 直线 + 固定颜色
    overview.linkTemplate = $(go.Link,
      {
        routing: go.Link.Normal,
        curve: go.Link.None  // 直线，不用 Bezier
      },
      $(go.Shape,
        {
          // 进一步增加粗细和不透明度，确保在小地图缩放后依然清晰可见
          strokeWidth: 12,
          stroke: styles.link.parentChildColor,
          opacity: 1.0 // 完全不透明以消除虚边
        }
      )
    );
    
    this.logger.debug('Overview 连接线模板已设置（简化版）');
  }
}
