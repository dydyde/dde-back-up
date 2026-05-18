package app.nanoflow.host

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class NanoflowWidgetGatePreviewPolicyTest {
  @Test
  fun `pending queue without actionable preview should skip optimistic gate patch`() {
    val actionable = hasActionableOptimisticGateEntry(
      blackBox = WidgetBlackBoxSummary(
        pendingCount = 2,
        previews = emptyList(),
        gatePreview = WidgetGatePreview(),
      ),
      privacyMode = false,
      now = Instant.parse("2026-05-18T05:00:00Z"),
    )

    assertFalse(actionable)
  }

  @Test
  fun `read cooldown fallback with entry id should remain actionable`() {
    val now = Instant.parse("2026-05-18T05:00:00Z")
    val preview = WidgetGatePreview(
      entryId = "entry-1",
      projectId = "project-1",
      projectTitle = "NanoFlow",
      content = "小地图预览框显示和界面真实呈现有误差",
      isRead = true,
      createdAt = "2026-05-18T04:40:00Z",
      updatedAt = "2026-05-18T04:55:00Z",
      valid = true,
    )

    val renderableEntries = resolveRenderableGateEntriesForBlackBox(
      blackBox = WidgetBlackBoxSummary(
        pendingCount = 1,
        previews = listOf(preview),
        gatePreview = WidgetGatePreview(),
      ),
      privacyMode = false,
      now = now,
    )

    assertEquals(listOf(preview), renderableEntries)
    assertTrue(
      hasActionableOptimisticGateEntry(
        blackBox = WidgetBlackBoxSummary(
          pendingCount = 1,
          previews = listOf(preview),
          gatePreview = WidgetGatePreview(),
        ),
        privacyMode = false,
        now = now,
      ),
    )
  }

  @Test
  fun `non privacy fallback without content should not apply optimistic gate patch`() {
    val preview = WidgetGatePreview(
      entryId = "entry-empty-content",
      projectId = "project-1",
      projectTitle = "NanoFlow",
      content = null,
      isRead = false,
      createdAt = "2026-05-18T04:40:00Z",
      updatedAt = "2026-05-18T04:45:00Z",
      valid = true,
    )
    val blackBox = WidgetBlackBoxSummary(
      pendingCount = 1,
      previews = listOf(preview),
      gatePreview = WidgetGatePreview(),
    )

    assertEquals(
      listOf(preview),
      resolveRenderableGateEntriesForBlackBox(
        blackBox = blackBox,
        privacyMode = false,
        now = Instant.parse("2026-05-18T05:00:00Z"),
      ),
    )
    assertFalse(
      hasActionableOptimisticGateEntry(
        blackBox = blackBox,
        privacyMode = false,
        now = Instant.parse("2026-05-18T05:00:00Z"),
      ),
    )
  }

  @Test
  fun `privacy mode can optimistically advance gate entry without exposing content`() {
    val blackBox = WidgetBlackBoxSummary(
      pendingCount = 1,
      previews = listOf(
        WidgetGatePreview(
          entryId = "entry-private",
          projectId = "project-1",
          content = null,
          valid = true,
        ),
      ),
      gatePreview = WidgetGatePreview(),
    )

    assertTrue(
      hasActionableOptimisticGateEntry(
        blackBox = blackBox,
        privacyMode = true,
        now = Instant.parse("2026-05-18T05:00:00Z"),
      ),
    )
  }

  @Test
  fun `optimistic read advances to next preview instead of keeping clicked card`() {
    val clickedPreview = WidgetGatePreview(
      entryId = "entry-read",
      projectId = "project-1",
      content = "已经读过但需要重新冷却的条目",
      isRead = true,
      createdAt = "2026-05-18T01:00:00Z",
      updatedAt = "2026-05-18T02:00:00Z",
      valid = true,
    )
    val nextPreview = WidgetGatePreview(
      entryId = "entry-next",
      projectId = "project-1",
      content = "下一条大门任务",
      isRead = false,
      createdAt = "2026-05-18T03:00:00Z",
      updatedAt = "2026-05-18T03:00:00Z",
      valid = true,
    )

    val patch = buildOptimisticBlackBoxActionPatch(
      blackBox = WidgetBlackBoxSummary(
        pendingCount = 2,
        unreadCount = 1,
        previews = listOf(clickedPreview, nextPreview),
        gatePreview = clickedPreview,
      ),
      entryId = "entry-read",
      action = BlackBoxEntryAction.READ,
      gateEntries = listOf(clickedPreview, nextPreview),
      selectedGateIndex = 0,
      previousSelectedEntryId = "entry-read",
      now = Instant.parse("2026-05-18T05:00:00Z"),
    )

    val optimisticPatch = assertNotNull(patch)
    assertEquals(listOf("entry-next"), optimisticPatch.blackBox.previews.map { it.entryId })
    assertEquals("entry-next", optimisticPatch.blackBox.gatePreview.entryId)
    assertEquals("entry-next", optimisticPatch.nextSelectedEntryId)
    assertEquals(1, optimisticPatch.blackBox.pendingCount)
  }

  @Test
  fun `optimistic read clears clicked fallback when there is no next preview`() {
    val clickedPreview = WidgetGatePreview(
      entryId = "entry-only",
      projectId = "project-1",
      content = "唯一的大门任务",
      isRead = true,
      createdAt = "2026-05-18T01:00:00Z",
      updatedAt = "2026-05-18T02:00:00Z",
      valid = true,
    )

    val patch = buildOptimisticBlackBoxActionPatch(
      blackBox = WidgetBlackBoxSummary(
        pendingCount = 1,
        unreadCount = 0,
        previews = listOf(clickedPreview),
        gatePreview = clickedPreview,
      ),
      entryId = "entry-only",
      action = BlackBoxEntryAction.READ,
      gateEntries = listOf(clickedPreview),
      selectedGateIndex = 0,
      previousSelectedEntryId = "entry-only",
      now = Instant.parse("2026-05-18T05:00:00Z"),
    )

    val optimisticPatch = assertNotNull(patch)
    assertTrue(optimisticPatch.blackBox.previews.isEmpty())
    assertFalse(optimisticPatch.blackBox.gatePreview.valid)
    assertEquals(null, optimisticPatch.blackBox.gatePreview.entryId)
    assertEquals(null, optimisticPatch.nextSelectedEntryId)
    assertEquals(0, optimisticPatch.blackBox.pendingCount)
  }
}