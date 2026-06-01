import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { Task } from '../../../../models';

/**
 * 任务关联区域组件
 * 显示任务的出入关联，支持折叠和跳转
 */
@Component({
  selector: 'app-text-task-connections',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (connections && (connections.outgoing.length > 0 || connections.incoming.length > 0)) {
      <div [ngClass]="{
        'flex-shrink-0 border-l border-violet-100 pl-2': !isMobile,
        'w-36': !isMobile && !isCollapsed(),
        'w-8': !isMobile && isCollapsed(),
        'border-t border-violet-100 pt-2 mt-2': isMobile
      }" class="transition-[width,padding,border-color,background-color,color] duration-200">
        
        <!-- 标题栏：点击可折叠/展开 -->
        <div class="flex items-center gap-1 cursor-pointer select-none"
             [ngClass]="{'mb-1.5': !isCollapsed(), 'flex-col': !isMobile && isCollapsed()}"
             (click)="toggleCollapse($event)">
          <span class="text-violet-500 text-xs">🔗</span>
          @if (!isCollapsed()) {
            <span class="text-[10px] font-medium text-violet-700">关联</span>
            <span class="text-[9px] text-violet-400">({{connections.outgoing.length + connections.incoming.length}})</span>
          } @else {
            <span class="text-[9px] text-violet-400 font-bold">{{connections.outgoing.length + connections.incoming.length}}</span>
          }
          <svg class="w-3 h-3 text-violet-400 transition-transform ml-auto"
               [ngClass]="{'rotate-180': isCollapsed(), '-rotate-90': !isMobile && !isCollapsed(), 'rotate-0': isMobile && !isCollapsed()}"
               fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </div>
        
        <!-- 关联内容：可折叠 -->
        @if (!isCollapsed()) {
          <div class="animate-collapse-open">
            <!-- 发出的关联（本任务指向其他任务） -->
            @if (connections.outgoing.length > 0) {
              <div class="mb-2">
                <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
                  </svg>
                  关联到
                </div>
                <div class="space-y-1">
                  @for (conn of connections.outgoing; track conn.targetId) {
                    <div class="flex items-start gap-2 p-1.5 bg-violet-50/50 rounded-lg border border-violet-100 group cursor-pointer hover:bg-violet-100/50 transition-colors"
                         (click)="onOpenTask(conn.targetTask!, $event)">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-1.5">
                          <span class="text-[9px] font-bold text-violet-400">{{projectState.compressDisplayId(conn.targetTask?.displayId || '?')}}</span>
                          <span class="text-[11px] text-violet-700 truncate font-medium">{{conn.targetTask?.title || '未命名'}}</span>
                        </div>
                        @if (conn.description) {
                          <div class="text-[10px] text-violet-500 mt-0.5 italic truncate">"{{conn.description}}"</div>
                        }
                      </div>
                      <svg class="w-3 h-3 flex-shrink-0 text-violet-400 group-hover:text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                      </svg>
                    </div>
                  }
                </div>
              </div>
            }
            
            <!-- 接收的关联（其他任务指向本任务） -->
            @if (connections.incoming.length > 0) {
              <div>
                <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16l-4-4m0 0l4-4m-4 4h18"/>
                  </svg>
                  被关联
                </div>
                <div class="space-y-1">
                  @for (conn of connections.incoming; track conn.sourceId) {
                    <div class="flex items-start gap-2 p-1.5 bg-indigo-50/50 rounded-lg border border-indigo-100 group cursor-pointer hover:bg-indigo-100/50 transition-colors"
                         (click)="onOpenTask(conn.sourceTask!, $event)">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-1.5">
                          <span class="text-[9px] font-bold text-indigo-400">{{projectState.compressDisplayId(conn.sourceTask?.displayId || '?')}}</span>
                          <span class="text-[11px] text-indigo-700 truncate font-medium">{{conn.sourceTask?.title || '未命名'}}</span>
                        </div>
                        @if (conn.description) {
                          <div class="text-[10px] text-indigo-500 mt-0.5 italic truncate">"{{conn.description}}"</div>
                        }
                      </div>
                      <svg class="w-3 h-3 flex-shrink-0 text-indigo-400 group-hover:text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                      </svg>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
  `]
})
export class TextTaskConnectionsComponent {
  readonly projectState = inject(ProjectStateService);
  
  @Input() connections: TaskConnectionInfo | null = null;
  @Input() isMobile = false;
  
  @Output() openTask = new EventEmitter<{ taskId: string; event: Event }>();
  
  readonly isCollapsed = signal(false);
  
  toggleCollapse(event: Event) {
    event.stopPropagation();
    this.isCollapsed.update(v => !v);
  }
  
  onOpenTask(task: Task, event: Event) {
    event.stopPropagation();
    if (task) {
      this.openTask.emit({ taskId: task.id, event });
    }
  }
}
