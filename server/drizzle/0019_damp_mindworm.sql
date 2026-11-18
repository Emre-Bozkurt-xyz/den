ALTER TABLE "media" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_media_processing_created" ON "media" USING btree ("created_at") WHERE "media"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "idx_messages_pending_created" ON "messages" USING btree ("created_at") WHERE "messages"."pending_upload";