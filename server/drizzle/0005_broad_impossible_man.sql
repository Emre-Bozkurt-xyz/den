CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_messages_body_trgm" ON "messages" USING gin ("body" gin_trgm_ops);