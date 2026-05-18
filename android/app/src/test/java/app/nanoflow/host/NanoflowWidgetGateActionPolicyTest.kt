package app.nanoflow.host

import kotlin.test.Test
import kotlin.test.assertEquals

class NanoflowWidgetGateActionPolicyTest {
  @Test
  fun `unread gate entry shows read and complete actions`() {
    assertEquals(
      listOf(
        NanoflowWidgetActionFactory.GATE_ACTION_READ,
        NanoflowWidgetActionFactory.GATE_ACTION_COMPLETE,
      ),
      resolveGateActionCodesForModel(gateModel(isRead = false)),
    )
  }

  @Test
  fun `read gate entry still keeps read and complete actions`() {
    assertEquals(
      listOf(
        NanoflowWidgetActionFactory.GATE_ACTION_READ,
        NanoflowWidgetActionFactory.GATE_ACTION_COMPLETE,
      ),
      resolveGateActionCodesForModel(gateModel(isRead = true)),
    )
  }

  @Test
  fun `non actionable fallback hides gate actions`() {
    assertEquals(
      emptyList(),
      resolveGateActionCodesForModel(gateModel(entryId = "entry-hidden", actionable = false)),
    )
  }

  @Test
  fun `empty gate hides gate actions`() {
    assertEquals(
      emptyList(),
      resolveGateActionCodesForModel(gateModel(entryId = null, empty = true)),
    )
  }

  private fun gateModel(
    isRead: Boolean = false,
    entryId: String? = "entry-1",
    actionable: Boolean = true,
    empty: Boolean = false,
  ): WidgetRenderModel {
    return WidgetRenderModel(
      modeLabel = "大门",
      statusBadge = null,
      title = if (empty) "暂无未完成任务" else "小地图预览框显示和界面真实呈现有误差",
      supportingLine = null,
      metricsLine = null,
      statusLine = "刚刚",
      primaryActionLabel = "大门",
      primaryAction = if (empty) WidgetPrimaryAction.OPEN_WORKSPACE else WidgetPrimaryAction.BLOCK_GATE_ACTIONS,
      tone = WidgetVisualTone.GATE,
      dockCount = 0,
      blackBoxCount = if (empty) 0 else 1,
      showStatCards = false,
      isGateMode = true,
      showGatePager = false,
      gatePageIndicator = null,
      canPageBackward = false,
      canPageForward = false,
      compact = false,
      sizeTier = WidgetSizeTier.LARGE,
      showSetup = false,
      showAuthRequired = false,
      showUntrusted = false,
      displayedGateEntryId = entryId,
      displayedGateEntryIsRead = isRead,
      displayedGateEntryIsActionable = actionable,
      contentCards = listOf(
        WidgetContentCard(
          title = if (empty) "暂无未完成任务" else "小地图预览框显示和界面真实呈现有误差",
          isGateEmptyState = empty,
        ),
      ),
    )
  }
}
