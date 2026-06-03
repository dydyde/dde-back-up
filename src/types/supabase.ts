export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          created_at: string | null
          description: string | null
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          created_at?: string | null
          description?: string | null
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      black_box_entries: {
        Row: {
          content: string
          completed_at: string | null
          created_at: string | null
          date: string
          deleted_at: string | null
          focus_meta: Json | null
          id: string
          is_archived: boolean
          is_completed: boolean
          is_read: boolean
          project_id: string | null
          snooze_count: number
          snooze_until: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          content: string
          completed_at?: string | null
          created_at?: string | null
          date?: string
          deleted_at?: string | null
          focus_meta?: Json | null
          id: string
          is_archived?: boolean
          is_completed?: boolean
          is_read?: boolean
          project_id?: string | null
          snooze_count?: number
          snooze_until?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          content?: string
          completed_at?: string | null
          created_at?: string | null
          date?: string
          deleted_at?: string | null
          focus_meta?: Json | null
          id?: string
          is_archived?: boolean
          is_completed?: boolean
          is_read?: boolean
          project_id?: string | null
          snooze_count?: number
          snooze_until?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "black_box_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "black_box_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      circuit_breaker_logs: {
        Row: {
          blocked: boolean
          created_at: string
          details: Json | null
          id: string
          operation: string
          reason: string | null
          user_id: string
        }
        Insert: {
          blocked?: boolean
          created_at?: string
          details?: Json | null
          id?: string
          operation: string
          reason?: string | null
          user_id: string
        }
        Update: {
          blocked?: boolean
          created_at?: string
          details?: Json | null
          id?: string
          operation?: string
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      cleanup_logs: {
        Row: {
          created_at: string | null
          details: Json | null
          id: string
          type: string
        }
        Insert: {
          created_at?: string | null
          details?: Json | null
          id?: string
          type: string
        }
        Update: {
          created_at?: string | null
          details?: Json | null
          id?: string
          type?: string
        }
        Relationships: []
      }
      connection_tombstones: {
        Row: {
          connection_id: string
          deleted_at: string
          deleted_by: string | null
          project_id: string
          source_id: string | null
          target_id: string | null
        }
        Insert: {
          connection_id: string
          deleted_at?: string
          deleted_by?: string | null
          project_id: string
          source_id?: string | null
          target_id?: string | null
        }
        Update: {
          connection_id?: string
          deleted_at?: string
          deleted_by?: string | null
          project_id?: string
          source_id?: string | null
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connection_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "connection_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          description: string | null
          id: string
          project_id: string
          source_id: string
          target_id: string
          title: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          project_id: string
          source_id: string
          target_id: string
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          project_id?: string
          source_id?: string
          target_id?: string
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      data_safety_flag_audit: {
        Row: {
          changed_at: string
          changed_by: string | null
          flag_key: string
          id: number
          new_value: string
          old_value: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          flag_key: string
          id?: never
          new_value: string
          old_value?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          flag_key?: string
          id?: never
          new_value?: string
          old_value?: string | null
        }
        Relationships: []
      }
      data_safety_flags: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      external_source_links: {
        Row: {
          created_at: string
          deleted_at: string | null
          hpath: string | null
          id: string
          label: string | null
          role: string | null
          sort_order: number
          source_type: string
          target_id: string
          task_id: string
          updated_at: string
          uri: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          hpath?: string | null
          id: string
          label?: string | null
          role?: string | null
          sort_order?: number
          source_type?: string
          target_id: string
          task_id: string
          updated_at?: string
          uri: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          hpath?: string | null
          id?: string
          label?: string | null
          role?: string | null
          sort_order?: number
          source_type?: string
          target_id?: string
          task_id?: string
          updated_at?: string
          uri?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "external_source_links_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_source_links_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "external_source_links_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      focus_sessions: {
        Row: {
          ended_at: string | null
          id: string
          session_state: Json
          started_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id: string
          session_state: Json
          started_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          session_state?: Json
          started_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_date: string | null
          data: Json | null
          deleted_at: string | null
          description: string | null
          id: string
          migrated_to_v2: boolean | null
          owner_id: string
          title: string | null
          updated_at: string | null
          version: number | null
        }
        Insert: {
          created_date?: string | null
          data?: Json | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          migrated_to_v2?: boolean | null
          owner_id: string
          title?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Update: {
          created_date?: string | null
          data?: Json | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          migrated_to_v2?: boolean | null
          owner_id?: string
          title?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Relationships: []
      }
      purge_rate_limits: {
        Row: {
          call_count: number | null
          user_id: string
          window_start: string | null
        }
        Insert: {
          call_count?: number | null
          user_id: string
          window_start?: string | null
        }
        Update: {
          call_count?: number | null
          user_id?: string
          window_start?: string | null
        }
        Relationships: []
      }
      routine_completion_events: {
        Row: {
          created_at: string
          date_key: string
          id: string
          routine_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          date_key: string
          id: string
          routine_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          date_key?: string
          id?: string
          routine_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_completion_events_routine_id_fkey"
            columns: ["routine_id"]
            isOneToOne: false
            referencedRelation: "routine_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      routine_completions: {
        Row: {
          count: number
          date_key: string
          id: string
          routine_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          count?: number
          date_key: string
          id: string
          routine_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          count?: number
          date_key?: string
          id?: string
          routine_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_completions_routine_id_fkey"
            columns: ["routine_id"]
            isOneToOne: false
            referencedRelation: "routine_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      routine_tasks: {
        Row: {
          created_at: string
          id: string
          is_enabled: boolean
          max_times_per_day: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          is_enabled?: boolean
          max_times_per_day?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          max_times_per_day?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_operation_log: {
        Row: {
          client_git_sha: string | null
          client_origin: string | null
          created_at: string
          deployment_epoch: number | null
          deployment_target: string | null
          entity_id: string
          entity_type: string
          operation_id: string
          payload_digest: string | null
          protocol_version: number | null
          reject_reason: string | null
          result_payload: Json | null
          status: string
          user_id: string
        }
        Insert: {
          client_git_sha?: string | null
          client_origin?: string | null
          created_at?: string
          deployment_epoch?: number | null
          deployment_target?: string | null
          entity_id: string
          entity_type: string
          operation_id: string
          payload_digest?: string | null
          protocol_version?: number | null
          reject_reason?: string | null
          result_payload?: Json | null
          status: string
          user_id: string
        }
        Update: {
          client_git_sha?: string | null
          client_origin?: string | null
          created_at?: string
          deployment_epoch?: number | null
          deployment_target?: string | null
          entity_id?: string
          entity_type?: string
          operation_id?: string
          payload_digest?: string | null
          protocol_version?: number | null
          reject_reason?: string | null
          result_payload?: Json | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_protocol_state: {
        Row: {
          deployment_epoch: number
          min_protocol_version: number
          reason: string | null
          scope: string
          updated_at: string
        }
        Insert: {
          deployment_epoch?: number
          min_protocol_version?: number
          reason?: string | null
          scope: string
          updated_at?: string
        }
        Update: {
          deployment_epoch?: number
          min_protocol_version?: number
          reason?: string | null
          scope?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_trusted_client_deployments: {
        Row: {
          client_git_sha: string
          created_at: string
          deployment_epoch: number
          deployment_target: string | null
          retired_at: string | null
        }
        Insert: {
          client_git_sha: string
          created_at?: string
          deployment_epoch: number
          deployment_target?: string | null
          retired_at?: string | null
        }
        Update: {
          client_git_sha?: string
          created_at?: string
          deployment_epoch?: number
          deployment_target?: string | null
          retired_at?: string | null
        }
        Relationships: []
      }
      sync_write_quarantine: {
        Row: {
          client_git_sha: string | null
          client_origin: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          expires_at: string
          id: number
          operation_id: string
          payload: Json
          payload_digest: string
          reason: string
          review_decision: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          user_id: string | null
        }
        Insert: {
          client_git_sha?: string | null
          client_origin?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          expires_at?: string
          id?: never
          operation_id: string
          payload: Json
          payload_digest: string
          reason: string
          review_decision?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          user_id?: string | null
        }
        Update: {
          client_git_sha?: string | null
          client_origin?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          expires_at?: string
          id?: never
          operation_id?: string
          payload?: Json
          payload_digest?: string
          reason?: string
          review_decision?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      task_change_audit: {
        Row: {
          changed_at: string
          client_git_sha: string | null
          client_origin: string | null
          deployment_epoch: number | null
          id: number
          new_content: string | null
          new_deleted_at: string | null
          new_parent_id: string | null
          new_stage: number | null
          new_title: string | null
          new_updated_at: string | null
          old_content: string | null
          old_deleted_at: string | null
          old_parent_id: string | null
          old_record: Json
          old_stage: number | null
          old_title: string | null
          old_updated_at: string | null
          op: string
          operation_id: string | null
          origin_unverified: boolean
          owner_id: string | null
          payload_digest: string | null
          project_id: string | null
          suspicious: boolean
          suspicious_reason: string | null
          task_id: string
        }
        Insert: {
          changed_at?: string
          client_git_sha?: string | null
          client_origin?: string | null
          deployment_epoch?: number | null
          id?: never
          new_content?: string | null
          new_deleted_at?: string | null
          new_parent_id?: string | null
          new_stage?: number | null
          new_title?: string | null
          new_updated_at?: string | null
          old_content?: string | null
          old_deleted_at?: string | null
          old_parent_id?: string | null
          old_record: Json
          old_stage?: number | null
          old_title?: string | null
          old_updated_at?: string | null
          op: string
          operation_id?: string | null
          origin_unverified?: boolean
          owner_id?: string | null
          payload_digest?: string | null
          project_id?: string | null
          suspicious?: boolean
          suspicious_reason?: string | null
          task_id: string
        }
        Update: {
          changed_at?: string
          client_git_sha?: string | null
          client_origin?: string | null
          deployment_epoch?: number | null
          id?: never
          new_content?: string | null
          new_deleted_at?: string | null
          new_parent_id?: string | null
          new_stage?: number | null
          new_title?: string | null
          new_updated_at?: string | null
          old_content?: string | null
          old_deleted_at?: string | null
          old_parent_id?: string | null
          old_record?: Json
          old_stage?: number | null
          old_title?: string | null
          old_updated_at?: string | null
          op?: string
          operation_id?: string | null
          origin_unverified?: boolean
          owner_id?: string | null
          payload_digest?: string | null
          project_id?: string | null
          suspicious?: boolean
          suspicious_reason?: string | null
          task_id?: string
        }
        Relationships: []
      }
      task_change_audit_archive: {
        Row: {
          changed_at: string
          client_git_sha: string | null
          client_origin: string | null
          deployment_epoch: number | null
          id: number
          new_content: string | null
          new_deleted_at: string | null
          new_parent_id: string | null
          new_stage: number | null
          new_title: string | null
          new_updated_at: string | null
          old_content: string | null
          old_deleted_at: string | null
          old_parent_id: string | null
          old_record: Json
          old_stage: number | null
          old_title: string | null
          old_updated_at: string | null
          op: string
          operation_id: string | null
          origin_unverified: boolean
          owner_id: string | null
          payload_digest: string | null
          project_id: string | null
          suspicious: boolean
          suspicious_reason: string | null
          task_id: string
        }
        Insert: {
          changed_at?: string
          client_git_sha?: string | null
          client_origin?: string | null
          deployment_epoch?: number | null
          id?: never
          new_content?: string | null
          new_deleted_at?: string | null
          new_parent_id?: string | null
          new_stage?: number | null
          new_title?: string | null
          new_updated_at?: string | null
          old_content?: string | null
          old_deleted_at?: string | null
          old_parent_id?: string | null
          old_record: Json
          old_stage?: number | null
          old_title?: string | null
          old_updated_at?: string | null
          op: string
          operation_id?: string | null
          origin_unverified?: boolean
          owner_id?: string | null
          payload_digest?: string | null
          project_id?: string | null
          suspicious?: boolean
          suspicious_reason?: string | null
          task_id: string
        }
        Update: {
          changed_at?: string
          client_git_sha?: string | null
          client_origin?: string | null
          deployment_epoch?: number | null
          id?: never
          new_content?: string | null
          new_deleted_at?: string | null
          new_parent_id?: string | null
          new_stage?: number | null
          new_title?: string | null
          new_updated_at?: string | null
          old_content?: string | null
          old_deleted_at?: string | null
          old_parent_id?: string | null
          old_record?: Json
          old_stage?: number | null
          old_title?: string | null
          old_updated_at?: string | null
          op?: string
          operation_id?: string | null
          origin_unverified?: boolean
          owner_id?: string | null
          payload_digest?: string | null
          project_id?: string | null
          suspicious?: boolean
          suspicious_reason?: string | null
          task_id?: string
        }
        Relationships: []
      }
      task_tombstones: {
        Row: {
          deleted_at: string
          deleted_by: string | null
          project_id: string
          task_id: string
        }
        Insert: {
          deleted_at?: string
          deleted_by?: string | null
          project_id: string
          task_id: string
        }
        Update: {
          deleted_at?: string
          deleted_by?: string | null
          project_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "task_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          attachments: Json | null
          cognitive_load: string | null
          completed_at: string | null
          content: string | null
          created_at: string | null
          deleted_at: string | null
          due_date: string | null
          expected_minutes: number | null
          id: string
          order: number | null
          parent_id: string | null
          parking_meta: Json | null
          priority: string | null
          project_id: string
          rank: number | null
          short_id: string | null
          stage: number | null
          status: string | null
          tags: Json | null
          title: string
          updated_at: string | null
          wait_minutes: number | null
          x: number | null
          y: number | null
        }
        Insert: {
          attachments?: Json | null
          cognitive_load?: string | null
          completed_at?: string | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          expected_minutes?: number | null
          id?: string
          order?: number | null
          parent_id?: string | null
          parking_meta?: Json | null
          priority?: string | null
          project_id: string
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string
          updated_at?: string | null
          wait_minutes?: number | null
          x?: number | null
          y?: number | null
        }
        Update: {
          attachments?: Json | null
          cognitive_load?: string | null
          completed_at?: string | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          expected_minutes?: number | null
          id?: string
          order?: number | null
          parent_id?: string | null
          parking_meta?: Json | null
          priority?: string | null
          project_id?: string
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string
          updated_at?: string | null
          wait_minutes?: number | null
          x?: number | null
          y?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_usage: {
        Row: {
          audio_seconds: number | null
          created_at: string | null
          date: string
          id: string
          user_id: string | null
        }
        Insert: {
          audio_seconds?: number | null
          created_at?: string | null
          date?: string
          id: string
          user_id?: string | null
        }
        Update: {
          audio_seconds?: number | null
          created_at?: string | null
          date?: string
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          auto_resolve_conflicts: boolean | null
          color_mode: string | null
          created_at: string | null
          floating_window_pref: string | null
          focus_preferences: Json | null
          id: string
          last_backup_proof_at: string | null
          layout_direction: string | null
          local_backup_enabled: boolean | null
          local_backup_interval_ms: number | null
          theme: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          auto_resolve_conflicts?: boolean | null
          color_mode?: string | null
          created_at?: string | null
          floating_window_pref?: string | null
          focus_preferences?: Json | null
          id?: string
          last_backup_proof_at?: string | null
          layout_direction?: string | null
          local_backup_enabled?: boolean | null
          local_backup_interval_ms?: number | null
          theme?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          auto_resolve_conflicts?: boolean | null
          color_mode?: string | null
          created_at?: string | null
          floating_window_pref?: string | null
          focus_preferences?: Json | null
          id?: string
          last_backup_proof_at?: string | null
          layout_direction?: string | null
          local_backup_enabled?: boolean | null
          local_backup_interval_ms?: number | null
          theme?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      widget_devices: {
        Row: {
          binding_generation: number
          capabilities: Json
          created_at: string
          expires_at: string
          id: string
          installation_id: string
          last_bound_user_hash: string
          last_seen_at: string
          platform: string
          push_token: string | null
          push_token_updated_at: string | null
          revoke_reason: string | null
          revoked_at: string | null
          secret_hash: string
          token_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          binding_generation?: number
          capabilities?: Json
          created_at?: string
          expires_at: string
          id: string
          installation_id: string
          last_bound_user_hash: string
          last_seen_at?: string
          platform: string
          push_token?: string | null
          push_token_updated_at?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          secret_hash: string
          token_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          binding_generation?: number
          capabilities?: Json
          created_at?: string
          expires_at?: string
          id?: string
          installation_id?: string
          last_bound_user_hash?: string
          last_seen_at?: string
          platform?: string
          push_token?: string | null
          push_token_updated_at?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          secret_hash?: string
          token_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      widget_devices_legacy_retired: {
        Row: {
          binding_generation: number | null
          capabilities: Json | null
          created_at: string | null
          expires_at: string | null
          id: string | null
          installation_id: string | null
          last_bound_user_hash: string | null
          last_seen_at: string | null
          platform: string | null
          push_token: string | null
          push_token_updated_at: string | null
          retired_at: string
          retirement_reason: string | null
          revoke_reason: string | null
          revoked_at: string | null
          secret_hash: string | null
          token_hash: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          binding_generation?: number | null
          capabilities?: Json | null
          created_at?: string | null
          expires_at?: string | null
          id?: string | null
          installation_id?: string | null
          last_bound_user_hash?: string | null
          last_seen_at?: string | null
          platform?: string | null
          push_token?: string | null
          push_token_updated_at?: string | null
          retired_at?: string
          retirement_reason?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          secret_hash?: string | null
          token_hash?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          binding_generation?: number | null
          capabilities?: Json | null
          created_at?: string | null
          expires_at?: string | null
          id?: string | null
          installation_id?: string | null
          last_bound_user_hash?: string | null
          last_seen_at?: string | null
          platform?: string | null
          push_token?: string | null
          push_token_updated_at?: string | null
          retired_at?: string
          retirement_reason?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          secret_hash?: string | null
          token_hash?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      widget_instances: {
        Row: {
          binding_generation: number
          config_scope: string
          created_at: string
          device_id: string
          host_instance_id: string
          id: string
          installed_at: string
          last_seen_at: string
          platform: string
          privacy_mode: string
          size_bucket: string
          uninstalled_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          binding_generation?: number
          config_scope?: string
          created_at?: string
          device_id: string
          host_instance_id: string
          id: string
          installed_at?: string
          last_seen_at?: string
          platform: string
          privacy_mode?: string
          size_bucket: string
          uninstalled_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          binding_generation?: number
          config_scope?: string
          created_at?: string
          device_id?: string
          host_instance_id?: string
          id?: string
          installed_at?: string
          last_seen_at?: string
          platform?: string
          privacy_mode?: string
          size_bucket?: string
          uninstalled_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_instances_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "widget_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_instances_legacy_retired: {
        Row: {
          binding_generation: number | null
          config_scope: string | null
          created_at: string | null
          device_id: string | null
          host_instance_id: string | null
          id: string | null
          installed_at: string | null
          last_seen_at: string | null
          platform: string | null
          privacy_mode: string | null
          retired_at: string
          retirement_reason: string | null
          size_bucket: string | null
          uninstalled_at: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          binding_generation?: number | null
          config_scope?: string | null
          created_at?: string | null
          device_id?: string | null
          host_instance_id?: string | null
          id?: string | null
          installed_at?: string | null
          last_seen_at?: string | null
          platform?: string | null
          privacy_mode?: string | null
          retired_at?: string
          retirement_reason?: string | null
          size_bucket?: string | null
          uninstalled_at?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          binding_generation?: number | null
          config_scope?: string | null
          created_at?: string | null
          device_id?: string | null
          host_instance_id?: string | null
          id?: string | null
          installed_at?: string | null
          last_seen_at?: string | null
          platform?: string | null
          privacy_mode?: string | null
          retired_at?: string
          retirement_reason?: string | null
          size_bucket?: string | null
          uninstalled_at?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      widget_notify_events: {
        Row: {
          created_at: string
          event_type: string
          last_status: string
          processed_at: string
          source_table: string
          summary_cursor: string | null
          updated_at: string
          user_id: string | null
          webhook_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          last_status?: string
          processed_at?: string
          source_table: string
          summary_cursor?: string | null
          updated_at?: string
          user_id?: string | null
          webhook_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          last_status?: string
          processed_at?: string
          source_table?: string
          summary_cursor?: string | null
          updated_at?: string
          user_id?: string | null
          webhook_id?: string
        }
        Relationships: []
      }
      widget_notify_throttle: {
        Row: {
          created_at: string
          last_event_id: string | null
          last_notified_at: string
          last_summary_version: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          last_event_id?: string | null
          last_notified_at?: string
          last_summary_version?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          last_event_id?: string | null
          last_notified_at?: string
          last_summary_version?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      widget_request_rate_limits: {
        Row: {
          blocked_until: string | null
          call_count: number
          created_at: string
          last_decision: string
          scope_key: string
          scope_type: string
          updated_at: string
          window_start: string
        }
        Insert: {
          blocked_until?: string | null
          call_count?: number
          created_at?: string
          last_decision?: string
          scope_key: string
          scope_type: string
          updated_at?: string
          window_start?: string
        }
        Update: {
          blocked_until?: string | null
          call_count?: number
          created_at?: string
          last_decision?: string
          scope_key?: string
          scope_type?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
    }
    Views: {
      active_connections: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          description: string | null
          id: string | null
          project_id: string | null
          source_id: string | null
          target_id: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string | null
          project_id?: string | null
          source_id?: string | null
          target_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string | null
          project_id?: string | null
          source_id?: string | null
          target_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      active_tasks: {
        Row: {
          attachments: Json | null
          content: string | null
          created_at: string | null
          deleted_at: string | null
          due_date: string | null
          id: string | null
          order: number | null
          parent_id: string | null
          priority: string | null
          project_id: string | null
          rank: number | null
          short_id: string | null
          stage: number | null
          status: string | null
          tags: Json | null
          title: string | null
          updated_at: string | null
          x: number | null
          y: number | null
        }
        Insert: {
          attachments?: Json | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          id?: string | null
          order?: number | null
          parent_id?: string | null
          priority?: string | null
          project_id?: string | null
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string | null
          updated_at?: string | null
          x?: number | null
          y?: number | null
        }
        Update: {
          attachments?: Json | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          id?: string | null
          order?: number | null
          parent_id?: string | null
          priority?: string | null
          project_id?: string | null
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string | null
          updated_at?: string | null
          x?: number | null
          y?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_structure_audit: {
        Row: {
          active_tasks: number | null
          child_tasks: number | null
          content_equals_title: number | null
          last_task_update: string | null
          owner_id: string | null
          project_id: string | null
          stage_null: number | null
          title: string | null
        }
        Relationships: []
      }
      stage_null_recovery_diagnostics: {
        Row: {
          audit_preimage_candidates: number | null
          child_n: number | null
          child_stages: number[] | null
          evidence_class: string | null
          materialized_sig: boolean | null
          owner_id: string | null
          parent_id: string | null
          parent_stage: number | null
          project_id: string | null
          soft_deleted_stage_candidates: number | null
          task_id: string | null
          title: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "stage_null_recovery_diagnostics"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_structure_audit"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      append_task_attachment: {
        Args: { p_attachment: Json; p_task_id: string }
        Returns: boolean
      }
      archive_old_task_change_audit: {
        Args: { p_retention?: string }
        Returns: number
      }
      batch_get_tombstones: { Args: { p_project_ids: string[] }; Returns: Json }
      batch_upsert_tasks: {
        Args: { p_project_id: string; p_tasks: Json[] }
        Returns: number
      }
      cleanup_cron_job_run_details: {
        Args: { p_max_age?: string }
        Returns: number
      }
      cleanup_deleted_attachments: {
        Args: { retention_days?: number }
        Returns: {
          deleted_count: number
          storage_paths: string[]
        }[]
      }
      cleanup_expired_scan_records: { Args: never; Returns: number }
      cleanup_old_deleted_connections: { Args: never; Returns: number }
      cleanup_old_deleted_tasks: { Args: never; Returns: number }
      cleanup_old_logs: { Args: never; Returns: number }
      cleanup_personal_retention_artifacts: { Args: never; Returns: Json }
      consume_widget_rate_limit: {
        Args: {
          p_block_seconds?: number
          p_max_calls: number
          p_scope_key: string
          p_scope_type: string
          p_window_seconds?: number
        }
        Returns: {
          allowed: boolean
          remaining_calls: number
          retry_after_seconds: number
        }[]
      }
      current_user_id: { Args: never; Returns: string }
      get_accessible_project_probe: {
        Args: { p_project_id: string }
        Returns: {
          accessible: boolean
          project_id: string
          watermark: string | null
        }[]
      }
      get_all_projects_data: {
        Args: { p_since_timestamp?: string }
        Returns: Json
      }
      get_black_box_sync_watermark: { Args: never; Returns: string | null }
      get_dashboard_stats: { Args: never; Returns: Json }
      get_full_project_data: { Args: { p_project_id: string }; Returns: Json }
      get_project_sync_watermark: {
        Args: { p_project_id: string }
        Returns: string | null
      }
      get_projects_list: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: Json
      }
      get_resume_recovery_probe: {
        Args: { p_project_id?: string }
        Returns: {
          active_accessible: boolean
          active_project_id: string | null
          active_watermark: string | null
          blackbox_watermark: string | null
          projects_watermark: string | null
          server_now: string | null
        }[]
      }
      get_server_time: { Args: never; Returns: string }
      get_user_projects_meta: {
        Args: { p_since_timestamp?: string }
        Returns: Json
      }
      get_user_projects_watermark: { Args: never; Returns: string | null }
      get_vault_secret: { Args: { p_name: string }; Returns: string }
      increment_routine_completion: {
        Args: {
          p_completion_id: string
          p_date_key: string
          p_routine_id: string
        }
        Returns: number
      }
      is_connection_tombstoned: {
        Args: { p_connection_id: string }
        Returns: boolean
      }
      is_task_tombstoned: { Args: { p_task_id: string }; Returns: boolean }
      list_project_heads_since: {
        Args: { p_since?: string }
        Returns: {
          project_id: string
          updated_at: string
          version: number
        }[]
      }
      migrate_all_projects_to_v2: {
        Args: never
        Returns: {
          connections_migrated: number
          errors: string[]
          project_id: string
          project_title: string
          tasks_migrated: number
        }[]
      }
      migrate_project_data_to_v2: {
        Args: { p_project_id: string }
        Returns: {
          connections_migrated: number
          errors: string[]
          tasks_migrated: number
        }[]
      }
      purge_expired_sync_write_quarantine: { Args: never; Returns: number }
      purge_tasks: { Args: { p_task_ids: string[] }; Returns: number }
      purge_tasks_v2: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: number
      }
      purge_tasks_v3: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: Database["public"]["CompositeTypes"]["purge_result"]
        SetofOptions: {
          from: "*"
          to: "purge_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_sync_write_quarantine: {
        Args: {
          p_client_git_sha: string
          p_client_origin: string
          p_entity_id: string
          p_entity_type: string
          p_operation_id: string
          p_payload: Json
          p_reason: string
          p_user_id: string
        }
        Returns: number
      }
      remove_task_attachment: {
        Args: { p_attachment_id: string; p_task_id: string }
        Returns: boolean
      }
      safe_delete_tasks: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: number
      }
      set_data_safety_flag: {
        Args: { p_key: string; p_value: string }
        Returns: undefined
      }
      soft_delete_project: { Args: { p_project_id: string }; Returns: boolean }
      sync_canonical_payload_digest: {
        Args: { p_payload: Json }
        Returns: string
      }
      sync_check_protocol: { Args: never; Returns: Json }
      sync_delete_project: { Args: { payload: Json }; Returns: Json }
      sync_delete_tasks: { Args: { payload: Json }; Returns: Json }
      sync_extract_local_updated: {
        Args: { entity_key: string; payload: Json }
        Returns: string
      }
      sync_upsert_blackbox_entry: { Args: { payload: Json }; Returns: Json }
      sync_upsert_connection: { Args: { payload: Json }; Returns: Json }
      sync_upsert_project: { Args: { payload: Json }; Returns: Json }
      sync_upsert_task: { Args: { payload: Json }; Returns: Json }
      user_accessible_project_ids: { Args: never; Returns: string[] }
      user_has_project_access: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      user_is_project_owner: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      widget_summary_fetch: {
        Args: { p_preview_limit?: number; p_today: string; p_user_id: string }
        Returns: Json
      }
      widget_summary_wave1: {
        Args: { p_preview_limit?: number; p_today: string; p_user_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      purge_result: {
        purged_count: number | null
        attachment_paths: string[] | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

