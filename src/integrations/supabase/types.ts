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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audio_sources: {
        Row: {
          device_label: string | null
          ended_at: string | null
          id: string
          metadata: Json
          session_id: string
          source_type: string
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          device_label?: string | null
          ended_at?: string | null
          id?: string
          metadata?: Json
          session_id: string
          source_type: string
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          device_label?: string | null
          ended_at?: string | null
          id?: string
          metadata?: Json
          session_id?: string
          source_type?: string
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audio_sources_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_claims: {
        Row: {
          claim: string
          confidence: number
          created_at: string
          id: string
          project_id: string | null
          said_by: string
          session_id: string
          topic: string
          user_id: string
        }
        Insert: {
          claim: string
          confidence?: number
          created_at?: string
          id?: string
          project_id?: string | null
          said_by?: string
          session_id: string
          topic: string
          user_id: string
        }
        Update: {
          claim?: string
          confidence?: number
          created_at?: string
          id?: string
          project_id?: string | null
          said_by?: string
          session_id?: string
          topic?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_claims_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_claims_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      companion_pairings: {
        Row: {
          approved_at: string | null
          bridge_token: string
          code: string
          companion_os: string | null
          companion_version: string | null
          created_at: string
          expires_at: string
          id: string
          revoked_at: string | null
          session_id: string
          status: string
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          bridge_token: string
          code: string
          companion_os?: string | null
          companion_version?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          revoked_at?: string | null
          session_id: string
          status?: string
          user_id: string
        }
        Update: {
          approved_at?: string | null
          bridge_token?: string
          code?: string
          companion_os?: string | null
          companion_version?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          revoked_at?: string | null
          session_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "companion_pairings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_releases: {
        Row: {
          architecture: string
          created_at: string
          file_name: string
          file_size: number | null
          file_url: string
          id: string
          is_active: boolean
          is_test_build: boolean
          minimum_os: string | null
          platform: string
          release_notes: string | null
          updated_at: string
          version: string
        }
        Insert: {
          architecture?: string
          created_at?: string
          file_name?: string
          file_size?: number | null
          file_url: string
          id?: string
          is_active?: boolean
          is_test_build?: boolean
          minimum_os?: string | null
          platform?: string
          release_notes?: string | null
          updated_at?: string
          version: string
        }
        Update: {
          architecture?: string
          created_at?: string
          file_name?: string
          file_size?: number | null
          file_url?: string
          id?: string
          is_active?: boolean
          is_test_build?: boolean
          minimum_os?: string | null
          platform?: string
          release_notes?: string | null
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      detected_questions: {
        Row: {
          category: string
          confidence: number | null
          created_at: string
          id: string
          normalized_question: string
          question_text: string
          session_id: string
          status: string
          transcript_segment_id: string | null
          user_id: string
        }
        Insert: {
          category?: string
          confidence?: number | null
          created_at?: string
          id?: string
          normalized_question: string
          question_text: string
          session_id: string
          status?: string
          transcript_segment_id?: string | null
          user_id: string
        }
        Update: {
          category?: string
          confidence?: number | null
          created_at?: string
          id?: string
          normalized_question?: string
          question_text?: string
          session_id?: string
          status?: string
          transcript_segment_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "detected_questions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "detected_questions_transcript_segment_id_fkey"
            columns: ["transcript_segment_id"]
            isOneToOne: false
            referencedRelation: "transcript_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          chunk_type: string
          content: string
          created_at: string
          document_id: string
          id: string
          metadata: Json
          user_id: string
        }
        Insert: {
          chunk_index?: number
          chunk_type?: string
          content: string
          created_at?: string
          document_id: string
          id?: string
          metadata?: Json
          user_id: string
        }
        Update: {
          chunk_index?: number
          chunk_type?: string
          content?: string
          created_at?: string
          document_id?: string
          id?: string
          metadata?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          error_message: string | null
          extracted_text: string | null
          file_name: string
          file_size: number | null
          id: string
          is_primary: boolean
          metadata: Json
          mime_type: string | null
          processing_status: string
          storage_path: string | null
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          extracted_text?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          is_primary?: boolean
          metadata?: Json
          mime_type?: string | null
          processing_status?: string
          storage_path?: string | null
          type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          extracted_text?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          is_primary?: boolean
          metadata?: Json
          mime_type?: string | null
          processing_status?: string
          storage_path?: string | null
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      generated_answers: {
        Row: {
          answer_length: string
          answer_style: string
          answer_text: string
          created_at: string
          first_token_ms: number | null
          generation_ms: number | null
          id: string
          is_pinned: boolean
          model: string | null
          question_id: string | null
          session_id: string
          user_id: string
        }
        Insert: {
          answer_length?: string
          answer_style?: string
          answer_text?: string
          created_at?: string
          first_token_ms?: number | null
          generation_ms?: number | null
          id?: string
          is_pinned?: boolean
          model?: string | null
          question_id?: string | null
          session_id: string
          user_id: string
        }
        Update: {
          answer_length?: string
          answer_style?: string
          answer_text?: string
          created_at?: string
          first_token_ms?: number | null
          generation_ms?: number | null
          id?: string
          is_pinned?: boolean
          model?: string | null
          question_id?: string | null
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "detected_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      interview_sessions: {
        Row: {
          answer_language: string
          answer_length: string
          answer_style: string
          company_name: string | null
          created_at: string
          credits_used: number
          duration_seconds: number
          ended_at: string | null
          id: string
          job_description: string | null
          language: string
          meeting_platform: string
          project_id: string | null
          resume_document_id: string | null
          rolling_summary: string | null
          session_type: string
          started_at: string | null
          status: string
          target_role: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          answer_language?: string
          answer_length?: string
          answer_style?: string
          company_name?: string | null
          created_at?: string
          credits_used?: number
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          job_description?: string | null
          language?: string
          meeting_platform?: string
          project_id?: string | null
          resume_document_id?: string | null
          rolling_summary?: string | null
          session_type?: string
          started_at?: string | null
          status?: string
          target_role?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          answer_language?: string
          answer_length?: string
          answer_style?: string
          company_name?: string | null
          created_at?: string
          credits_used?: number
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          job_description?: string | null
          language?: string
          meeting_platform?: string
          project_id?: string | null
          resume_document_id?: string | null
          rolling_summary?: string | null
          session_type?: string
          started_at?: string | null
          status?: string
          target_role?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interview_sessions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interview_sessions_resume_document_id_fkey"
            columns: ["resume_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_facts: {
        Row: {
          confidence: number
          created_at: string
          id: string
          label: string
          project_id: string | null
          said_by: string
          session_id: string
          superseded_at: string | null
          user_id: string
          value: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          id?: string
          label: string
          project_id?: string | null
          said_by?: string
          session_id: string
          superseded_at?: string | null
          user_id: string
          value: string
        }
        Update: {
          confidence?: number
          created_at?: string
          id?: string
          label?: string
          project_id?: string | null
          said_by?: string
          session_id?: string
          superseded_at?: string | null
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_facts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_facts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_preparations: {
        Row: {
          avoid_claims: string | null
          brief: string | null
          budget_notes: string | null
          challenges: string | null
          client_concerns: string | null
          client_website: string | null
          company_name: string | null
          created_at: string
          custom_notes: string | null
          emphasize: string | null
          goals: string | null
          id: string
          important_facts: string | null
          meeting_title: string | null
          meeting_type: string
          previous_communication: string | null
          project_description: string | null
          project_id: string | null
          project_name: string | null
          requirements: string | null
          role_discussed: string | null
          session_id: string
          tech_stack: string | null
          timeline: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avoid_claims?: string | null
          brief?: string | null
          budget_notes?: string | null
          challenges?: string | null
          client_concerns?: string | null
          client_website?: string | null
          company_name?: string | null
          created_at?: string
          custom_notes?: string | null
          emphasize?: string | null
          goals?: string | null
          id?: string
          important_facts?: string | null
          meeting_title?: string | null
          meeting_type?: string
          previous_communication?: string | null
          project_description?: string | null
          project_id?: string | null
          project_name?: string | null
          requirements?: string | null
          role_discussed?: string | null
          session_id: string
          tech_stack?: string | null
          timeline?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avoid_claims?: string | null
          brief?: string | null
          budget_notes?: string | null
          challenges?: string | null
          client_concerns?: string | null
          client_website?: string | null
          company_name?: string | null
          created_at?: string
          custom_notes?: string | null
          emphasize?: string | null
          goals?: string | null
          id?: string
          important_facts?: string | null
          meeting_title?: string | null
          meeting_type?: string
          previous_communication?: string | null
          project_description?: string | null
          project_id?: string | null
          project_name?: string | null
          requirements?: string | null
          role_discussed?: string | null
          session_id?: string
          tech_stack?: string | null
          timeline?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_preparations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_preparations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          answer_language: string
          avatar_url: string | null
          created_at: string
          current_position: string | null
          default_answer_length: string
          default_answer_style: string
          experience_level: string | null
          full_name: string | null
          id: string
          onboarded: boolean
          preferred_language: string
          settings: Json
          target_role: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          answer_language?: string
          avatar_url?: string | null
          created_at?: string
          current_position?: string | null
          default_answer_length?: string
          default_answer_style?: string
          experience_level?: string | null
          full_name?: string | null
          id?: string
          onboarded?: boolean
          preferred_language?: string
          settings?: Json
          target_role?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          answer_language?: string
          avatar_url?: string | null
          created_at?: string
          current_position?: string | null
          default_answer_length?: string
          default_answer_style?: string
          experience_level?: string | null
          full_name?: string | null
          id?: string
          onboarded?: boolean
          preferred_language?: string
          settings?: Json
          target_role?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          client_name: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          shared_notes: string | null
          updated_at: string
          user_id: string
          website_url: string | null
        }
        Insert: {
          client_name?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          shared_notes?: string | null
          updated_at?: string
          user_id: string
          website_url?: string | null
        }
        Update: {
          client_name?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          shared_notes?: string | null
          updated_at?: string
          user_id?: string
          website_url?: string | null
        }
        Relationships: []
      }
      session_notes: {
        Row: {
          action_items: string | null
          created_at: string
          follow_up_topics: string | null
          id: string
          improvement_areas: string | null
          key_topics: string | null
          questions_summary: string | null
          session_id: string
          strengths: string | null
          summary: string | null
          user_id: string
        }
        Insert: {
          action_items?: string | null
          created_at?: string
          follow_up_topics?: string | null
          id?: string
          improvement_areas?: string | null
          key_topics?: string | null
          questions_summary?: string | null
          session_id: string
          strengths?: string | null
          summary?: string | null
          user_id: string
        }
        Update: {
          action_items?: string | null
          created_at?: string
          follow_up_topics?: string | null
          id?: string
          improvement_areas?: string | null
          key_topics?: string | null
          questions_summary?: string | null
          session_id?: string
          strengths?: string | null
          summary?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_notes_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      transcript_segments: {
        Row: {
          confidence: number | null
          created_at: string
          ended_at_ms: number | null
          id: string
          is_final: boolean
          sequence_number: number
          session_id: string
          source: string
          speaker: string
          started_at_ms: number | null
          text: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          ended_at_ms?: number | null
          id?: string
          is_final?: boolean
          sequence_number?: number
          session_id: string
          source?: string
          speaker?: string
          started_at_ms?: number | null
          text: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          ended_at_ms?: number | null
          id?: string
          is_final?: boolean
          sequence_number?: number
          session_id?: string
          source?: string
          speaker?: string
          started_at_ms?: number | null
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcript_segments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          quantity: number
          session_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          quantity?: number
          session_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          quantity?: number
          session_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "interview_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_credits: {
        Row: {
          available_seconds: number
          id: string
          plan: string
          subscription_status: string
          updated_at: string
          used_seconds: number
          user_id: string
        }
        Insert: {
          available_seconds?: number
          id?: string
          plan?: string
          subscription_status?: string
          updated_at?: string
          used_seconds?: number
          user_id: string
        }
        Update: {
          available_seconds?: number
          id?: string
          plan?: string
          subscription_status?: string
          updated_at?: string
          used_seconds?: number
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
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
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
