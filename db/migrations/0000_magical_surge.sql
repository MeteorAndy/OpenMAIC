CREATE TABLE "chat_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"messages" jsonb,
	"config" jsonb,
	"tool_calls" jsonb,
	"pending_tool_calls" jsonb,
	"scene_id" text,
	"last_action_index" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"language_directive" text,
	"style" text,
	"current_scene_id" text,
	"agent_ids" text[],
	"video_manifest" jsonb,
	"interactive_mode" boolean DEFAULT false,
	"task_engine_mode" boolean DEFAULT false,
	"dsl_version" text,
	"outline" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_agent" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"persona" text NOT NULL,
	"avatar" text NOT NULL,
	"color" text NOT NULL,
	"priority" integer NOT NULL,
	"voice_design" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_file" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" text NOT NULL,
	"type" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"prompt" text,
	"params" jsonb,
	"oss_key" text,
	"poster_oss_key" text,
	"error" text,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_monthly_cents" integer DEFAULT 0 NOT NULL,
	"max_generations_per_period" integer,
	"max_tokens_per_period" integer,
	"max_media_seconds_per_period" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"order" integer NOT NULL,
	"content" jsonb,
	"actions" jsonb,
	"whiteboard" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp NOT NULL,
	"current_period_end" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp NOT NULL,
	"generations" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"media_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_session_course_idx" ON "chat_session" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "course_user_idx" ON "course" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "media_course_idx" ON "media_file" USING btree ("course_id","type");--> statement-breakpoint
CREATE INDEX "scene_course_idx" ON "scene" USING btree ("course_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_user_idx" ON "subscription" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_user_period_idx" ON "usage" USING btree ("user_id","period_start");