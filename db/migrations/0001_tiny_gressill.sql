ALTER TABLE "account" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "session" CASCADE;--> statement-breakpoint
DROP TABLE "user" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_session" DROP CONSTRAINT "chat_session_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_session" DROP CONSTRAINT "chat_session_course_id_course_id_fk";
--> statement-breakpoint
ALTER TABLE "course" DROP CONSTRAINT "course_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "generated_agent" DROP CONSTRAINT "generated_agent_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "generated_agent" DROP CONSTRAINT "generated_agent_course_id_course_id_fk";
--> statement-breakpoint
ALTER TABLE "media_file" DROP CONSTRAINT "media_file_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "media_file" DROP CONSTRAINT "media_file_course_id_course_id_fk";
--> statement-breakpoint
ALTER TABLE "scene" DROP CONSTRAINT "scene_course_id_course_id_fk";
--> statement-breakpoint
ALTER TABLE "scene" DROP CONSTRAINT "scene_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_plan_id_plan_id_fk";
--> statement-breakpoint
ALTER TABLE "usage" DROP CONSTRAINT "usage_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "dsl_version" text;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "outline" jsonb;