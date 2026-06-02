import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function sliceBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe('android host contract', () => {
  it('declares the TWA launcher, bootstrap callback, and widget provider in the manifest', () => {
    const manifest = readText('android/app/src/main/AndroidManifest.xml');
    const build = readText('android/app/build.gradle.kts');

    expect(manifest).toContain('NanoflowTwaLauncherActivity');
    expect(manifest).toContain('NanoflowWidgetBootstrapActivity');
    expect(manifest).toContain('NanoflowWidgetReceiver');
    expect(manifest).toContain('android.support.customtabs.trusted.DEFAULT_URL');
    expect(manifest).toContain('android:scheme="nanoflow-widget"');
    expect(build).toContain('ANDROID_TWA_PACKAGE_NAME');
    expect(build).toContain('NANOFLOW_WEB_ORIGIN');
    expect(build).toContain('NG_APP_SUPABASE_URL');
    expect(build).toContain('androidbrowserhelper');
  });

  it('keeps widget launches on the TWA path without launcher watchdog fallback code', () => {
    const launcher = readText('android/app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt');
    const launchFlow = sliceBetween(
      launcher,
      'private fun launchFromCurrentIntent() {',
      '\n  private fun resetReactiveRefreshGateIfNeeded()',
    );

    expect(launcher).toContain('class NanoflowTwaLauncherActivity : LauncherActivity()');
    expect(launcher).toContain('override fun shouldLaunchImmediately(): Boolean = false');
    expect(launcher).toContain('logLaunchStarted()');
    expect(launcher).toContain('launchTwa()');
    expect(launcher).toContain('widget_twa_launch_started');
    expect(launcher).not.toContain('widget_twa_launch_timeout');
    expect(launcher).not.toContain('widget_twa_cct_fallback_launching');
    expect(launcher).not.toContain('widget_twa_cct_fallback_failed');
    expect(launcher).not.toContain('CustomTabsIntent');
    expect(launcher).not.toContain('TWA_LAUNCH_TIMEOUT_MS');
    expect(launcher).not.toContain('scheduleLaunchWatchdog');
    expect(launcher).not.toContain('handleLaunchTimeout');
    expect(launchFlow.indexOf('launchTwa()')).toBeGreaterThan(launchFlow.indexOf('logLaunchStarted()'));
    expect(launchFlow).not.toContain('finish()');
    expect(launchFlow).not.toContain('startActivity(');
    expect(launchFlow).not.toContain('maybePromptOnLaunch');
  });

  it('bypasses the ABH saved-state finish branch that caused app-icon white flashes', () => {
    const launcher = readText('android/app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt');
    const onCreate = sliceBetween(
      launcher,
      'override fun onCreate(savedInstanceState: Bundle?) {',
      '\n  override fun onDestroy()',
    );
    const superOnCreateArgs = Array.from(onCreate.matchAll(/super\.onCreate\(([^)]*)\)/g))
      .map(match => match[1].trim());

    expect(superOnCreateArgs).toEqual(['null']);
    expect(onCreate).toContain('launchFromCurrentIntent()');
    expect(onCreate.indexOf('launchFromCurrentIntent()')).toBeGreaterThan(onCreate.indexOf('super.onCreate(null)'));
    expect(onCreate).not.toContain('super.onCreate(savedInstanceState)');
    expect(onCreate).not.toMatch(/\n\s*finish\(\)\s*\n/);
  });

  it('keeps MIUI autostart repair out of the TWA launcher path', () => {
    const launcher = readText('android/app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt');
    const guide = readText('android/app/src/main/java/app/nanoflow/host/MiuiAutostartGuide.kt');
    const onCreate = sliceBetween(
      launcher,
      'override fun onCreate(savedInstanceState: Bundle?) {',
      '\n  override fun onDestroy()',
    );

    expect(onCreate).toContain('super.onCreate(null)');
    expect(onCreate).toContain('launchFromCurrentIntent()');
    expect(onCreate).not.toContain('MiuiAutostartGuide.maybePromptOnLaunch');
    expect(onCreate).not.toMatch(/\n\s*finish\(\)\s*\n/);
    expect(launcher).not.toContain('MiuiAutostartGuide');
    expect(launcher).not.toContain('startActivity(');
    expect(guide).toContain('不能放进 NanoflowTwaLauncherActivity 的主启动链路');
  });

  it('uses authenticated web bootstrap instead of native widget-register calls', () => {
    const contract = readText('android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');
    const bootstrapActivity = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetBootstrapActivity.kt');
    const bindingService = readText('src/services/widget-binding.service.ts');
    const workspaceShell = readText('src/workspace-shell.component.ts');

    expect(contract).toContain('PARAM_WIDGET_BOOTSTRAP');
    expect(contract).toContain('PARAM_CALLBACK_URI');
    expect(contract).toContain('PARAM_DEVICE_SECRET');
    expect(contract).toContain('PARAM_CLIENT_VERSION');
    expect(contract).toContain('PARAM_BOOTSTRAP_NONCE');
    expect(contract).toContain('PARAM_SUPABASE_URL');
    expect(contract).toContain('nanoflow-widget');
    expect(repository).toContain('buildLaunchUri');
    expect(repository).toContain('consumeBootstrapUri');
    expect(repository).toContain('widget_bootstrap_callback_accepted');
    expect(repository).toContain('widget_bootstrap_callback_rejected');
    expect(repository).not.toContain('widget-register');
    expect(bootstrapActivity).toContain('consumeBootstrapUri');
    expect(bootstrapActivity).toContain('returnToWidgetHostSurface');
    expect(bootstrapActivity).toContain('Intent.ACTION_MAIN');
    expect(bootstrapActivity).toContain('Intent.CATEGORY_HOME');
    expect(bindingService).toContain("platform: 'android-widget'");
    expect(bindingService).toContain('persistRuntimeBinding: false');
    expect(bindingService).toContain('callbackIntentUrl');
    expect(workspaceShell).toContain('resolveAndroidWidgetBootstrapRequest');
    expect(workspaceShell).toContain('completeAndroidWidgetBootstrap');
  });

  it('keeps Android dirty push handling compatible with both payload variants', () => {
    const messagingService = readText('android/app/src/main/java/app/nanoflow/host/NanoflowFirebaseMessagingService.kt');

    expect(messagingService).toContain('message.data["type"]');
    expect(messagingService).toContain('message.data["action"]');
    expect(messagingService).toContain('widget_dirty');
    expect(messagingService).toContain('widget-refresh');
  });

  it('routes widget gate read and complete actions through a receiver-backed PendingIntent', () => {
    const manifest = readText('android/app/src/main/AndroidManifest.xml');
    const receiver = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt');
    const renderer = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRenderer.kt');

    expect(manifest).toContain('NanoflowWidgetActionActivity');
    expect(receiver).toContain('fun gateActionClickTemplatePendingIntent');
    expect(receiver).toContain('PendingIntent.getBroadcast');
    expect(receiver).toContain('action = ACTION_CLICK_ITEM');
    expect(receiver).toContain('ITEM_TYPE_GATE_ACTION');
    expect(renderer).toContain('NanoflowWidgetReceiver.gateActionClickTemplatePendingIntent');
  });

  it('advances the displayed gate entry immediately when widget read starts cooldown', () => {
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');

    expect(repository).toContain('resolveNextGateEntryIdForBlackBox');
    expect(repository).toContain('filterNot { it.entryId == entryId }');
    expect(repository).toContain('BlackBoxEntryAction.READ -> resolveNextGateEntryIdForBlackBox(candidateEntries, now)');
  });

  it('keeps widget gate read entries quiet only during the cooldown window', () => {
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');

    expect(repository).toContain('GATE_READ_REAPPEAR_COOLDOWN_MS');
    expect(repository).toContain('return resolveRenderableGateEntriesForBlackBox(summary.blackBox, privacyMode)');
    expect(repository).toContain('internal fun resolveRenderableGateEntriesForBlackBox(');
    expect(repository).toContain('private fun isGateReadCoolingDown(preview: WidgetGatePreview): Boolean');
    expect(repository).toContain('scheduleGateReadCooldownRefreshFromSummary(appWidgetId, reconciledSummary)');
    expect(repository).toContain('summary.blackBox.nextReviewAt');
    expect(repository).toMatch(
      /isGateReadCoolingDownForBlackBox\(preview, now\)[\s\S]*?preferRicherGatePreviewForBlackBox\(entries\[renderableIndex\], preview\)[\s\S]*?fallbackEntries\.add\(preview\)/,
    );
    expect(repository).toContain('return summary.blackBox.pendingCount.coerceAtLeast(0)');
    expect(repository).toContain('BlackBoxEntryAction.READ -> (blackBox.pendingCount - 1).coerceAtLeast(0)');
    expect(repository).toContain('gateEntries.isEmpty()');
    expect(repository).toContain('&& gateQueueCount == 0');
  });

  it('keeps widget gate actions local-first without success toasts or remote blocking', () => {
    const handler = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetGateActionHandler.kt');
    const factory = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt');
    const worker = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRefreshWorker.kt');

    expect(handler).toContain('submitRemoteAction');
    expect(handler).toContain('partialUpdate = true');
    expect(handler).toContain('scheduleGateReadCooldownRefresh');
    expect(handler).not.toContain('remoteActionScope.launch');
    expect(factory).toContain('displayedGateEntryIsActionable');
    expect(worker).toContain('GATE_READ_COOLDOWN_REFRESH_WORK_PREFIX');
    expect(worker).toContain('GATE_READ_REAPPEAR_COOLDOWN_MS');
    expect(worker).toContain('setInitialDelay(delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)');
    expect(handler).not.toContain('已标记为已读');
    expect(handler).not.toContain('已标记为完成');
  });

  it('rebuilds MIUI gate host state when stale empty content would hide pending black box entries', () => {
    const receiver = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt');
    const renderer = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRenderer.kt');

    expect(receiver).toContain('stateToken: String? = null');
    expect(receiver).toContain('nanoflow://widget/actions/$appWidgetId/$listKind$identitySuffix');
    expect(receiver).toContain('!shouldForceFullUpdate(model)');
    expect(receiver).toContain('private fun shouldForceFullUpdate(model: WidgetRenderModel): Boolean');
    expect(receiver).toContain('if (model.sizeTier == WidgetSizeTier.SMALL)');
    expect(receiver).toContain('if (!model.isGateMode)');
    expect(receiver).toContain('if (model.contentCards.firstOrNull()?.isGateEmptyState == true)');
    expect(receiver).toContain('return model.displayedGateEntryId?.isNotBlank() == true');
    expect(renderer).toContain('stateToken = buildContentAdapterStateToken(model)');
    expect(renderer).toContain('stateToken = buildGateActionsAdapterStateToken(model)');
    expect(renderer).toContain('private fun buildContentAdapterStateToken(model: WidgetRenderModel): String');
    expect(renderer).toContain('model.displayedGateEntryId');
    expect(renderer).toContain('model.blackBoxCount.toString()');
  });

  it('primes web Gate sync when Android widget opens the workspace', () => {
    const shell = readText('src/workspace-shell.component.ts');
    const probe = readText('src/services/focus-startup-probe.service.ts');

    expect(shell).toContain('this.focusStartupProbe.primeWidgetWorkspaceGateSync()');
    expect(probe).toContain('primeWidgetWorkspaceGateSync()');
    expect(probe).toContain("source: remoteFirst ? 'widget-open-workspace' : options.source");
  });

  it('keeps recent focus push hints from being overwritten by stale summary refreshes', () => {
    const store = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetStore.kt');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');

    expect(store).toContain('persistPendingFocusActiveHint');
    expect(store).toContain('readPendingFocusActiveHint');
    expect(store).toContain('clearPendingFocusActiveHint');
    expect(repository).toContain('FOCUS_HINT_GRACE_MS');
    expect(repository).toContain('reconcileRecentFocusHint');
    expect(repository).toContain('cloud-pending-local-hint');
    expect(repository).toContain('store.persistPendingFocusActiveHint(appWidgetId, hintActive)');
    expect(repository).toContain('reconcileRecentFocusHint(appWidgetId, normalizedSummary, cachedSummary)');
  });

  it('keeps optimistic focus wait order from being overwritten by stale summary refreshes', () => {
    const store = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetStore.kt');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');

    expect(store).toContain('persistPendingFocusMutation');
    expect(store).toContain('readPendingFocusMutation');
    expect(store).toContain('clearPendingFocusMutation');
    expect(repository).toContain('FOCUS_MUTATION_GRACE_MS');
    expect(repository).toContain('reconcilePendingFocusMutation');
    expect(repository).toContain('cloud-pending-local-focus-mutation');
    expect(repository).toContain('store.persistPendingFocusMutation(appWidgetId, FOCUS_MUTATION_WAIT)');
    expect(repository).toContain('reconcilePendingFocusMutation(appWidgetId, normalizedSummary, cachedSummary)');
  });

  it('keeps focus widget complete/wait actions local-first and refreshable', () => {
    const layout = readText('android/app/src/main/res/layout/nano_widget_large.xml');
    const factory = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt');
    const receiver = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt');
    const renderer = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRenderer.kt');
    const strings = readText('android/app/src/main/res/values/strings.xml');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');
    const worker = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRefreshWorker.kt');

    expect(layout).toContain('nano_widget_focus_actions_list');
    expect(layout).toContain('nano_widget_focus_wait_presets_list');
    expect(factory).toContain('LIST_KIND_FOCUS_ACTIONS');
    expect(factory).toContain('LIST_KIND_FOCUS_WAIT_PRESETS');
    expect(factory).toContain('FOCUS_ACTION_COMPLETE');
    expect(factory).toContain('FOCUS_ACTION_WAIT');
    expect(factory).toContain('FOCUS_ACTION_WAIT_PRESET');
    expect(renderer).toContain('renderFocusWaitPresetList');
    expect(renderer).toContain('nanoflow_widget_focus_wait_menu_label');
    expect(strings).toContain('name="nanoflow_widget_focus_wait_menu_label"');
    expect(receiver).toContain('R.id.nano_widget_focus_actions_list');
    expect(receiver).toContain('R.id.nano_widget_focus_wait_presets_list');
    expect(receiver).toContain('completeFrontFocusTask');
    expect(receiver).toContain('suspendFrontFocusTask');
    expect(repository).toContain('applyOptimisticFocusCompletion');
    expect(repository).toContain('applyOptimisticFocusWait');
    expect(worker).toContain('scheduleFocusWaitReminder');
  });

  it('keeps the optimistic wait preset state when remote wait submission is delayed or rejected', () => {
    const receiver = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt');
    const branchStart = receiver.indexOf('NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT_PRESET ->');
    const branchEnd = receiver.indexOf('else -> {', branchStart);
    const waitPresetBranch = receiver.slice(branchStart, branchEnd);

    expect(waitPresetBranch).toContain('repository.applyOptimisticFocusWait');
    expect(waitPresetBranch).toContain('repository.suspendFrontFocusTask');
    expect(waitPresetBranch).toContain('focus-wait-front-retry');
    expect(waitPresetBranch).toContain('scheduleFocusWaitReminder');
    expect(waitPresetBranch).not.toContain('rollbackOptimisticFocusPromotion');
  });

  it('keeps the focus widget advertised as a 4x2 launcher widget', () => {
    const widgetInfo = readText('android/app/src/main/res/xml/nanoflow_focus_widget_info.xml');
    const focusLayout = readText('android/app/src/main/res/layout/nano_widget_large.xml');
    const tabItem = readText('android/app/src/main/res/layout/nano_widget_tab_item.xml');
    const focusActionItem = readText('android/app/src/main/res/layout/nano_widget_focus_action_item.xml');
    const rootFocus = readText('android/app/src/main/res/drawable/nano_widget_root_focus.xml');

    expect(widgetInfo).toContain('android:minWidth="180dp"');
    expect(widgetInfo).toContain('android:minHeight="110dp"');
    expect(widgetInfo).toContain('android:targetCellWidth="4"');
    expect(widgetInfo).toContain('android:targetCellHeight="2"');
    expect(focusLayout).toContain('android:paddingStart="16dp"');
    expect(focusLayout).toContain('android:paddingTop="14dp"');
    expect(focusLayout).toContain('android:columnWidth="60dp"');
    expect(focusLayout).toContain('android:horizontalSpacing="10dp"');
    expect(focusLayout).toContain('android:layout_height="76dp"');
    expect(focusLayout).toContain('android:stretchMode="columnWidth"');
    expect(focusLayout).toContain('android:layout_width="164dp"');
    expect(focusLayout).toContain('android:columnWidth="72dp"');
    expect(focusLayout).toContain('android:numColumns="2"');
    expect(tabItem).toContain('android:layout_width="match_parent"');
    expect(tabItem).toContain('android:layout_height="72dp"');
    expect(tabItem).toContain('android:maxLines="1"');
    expect(tabItem).toContain('android:textSize="10sp"');
    expect(focusActionItem).toContain('android:layout_height="34dp"');
    expect(focusActionItem).toContain('android:minHeight="28dp"');
    expect(focusActionItem).toContain('android:textSize="12sp"');
    expect(rootFocus).toContain('@drawable/nano_widget_blueprint_grid');
    expect(rootFocus).toContain('android:radius="28dp"');
  });

  it('keeps Android widget bootstrap callbacks and gate RemoteViews launcher-safe', () => {
    const bindingService = readText('src/services/widget-binding.service.ts');
    const gateLayout = readText('android/app/src/main/res/layout/nano_widget_large_gate.xml');

    expect(bindingService).toContain('callbackUrl.search = callbackParams.toString()');
    expect(bindingService).not.toContain('callbackUrl.hash = callbackParams.toString()');
    expect(gateLayout).toContain('<ListView');
    expect(gateLayout).not.toContain('<AdapterViewFlipper');
    expect(gateLayout).toContain('android:id="@+id/nano_widget_content_list"');
  });

  it('repairs missing widget bearer tokens through bootstrap instead of showing login-required UI', () => {
    const store = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetStore.kt');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');

    expect(store).toContain('securePreferences.getString("binding.widgetToken", null)?.trim()?.takeIf { it.isNotBlank() } ?: return null');
    expect(store).toContain('.putString("binding.widgetToken", normalizedWidgetToken)');
    expect(repository).toContain('"WIDGET_TOKEN_REQUIRED",');
    expect(repository).toContain('val normalizedBearerToken = bearerToken.trim()');
    expect(repository).toContain('require(normalizedBearerToken.isNotBlank())');
    expect(repository).toContain('setRequestProperty("Authorization", "Bearer $normalizedBearerToken")');
  });
});
