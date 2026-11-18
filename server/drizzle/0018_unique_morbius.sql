ALTER TABLE "messages" ADD COLUMN "pending_upload" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_nonce" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_nonce_unique" ON "messages" USING btree ("sender_id","client_nonce") WHERE "messages"."client_nonce" IS NOT NULL;