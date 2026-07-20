CREATE TABLE "media" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"uploader_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"r2_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" bigint,
	"height" bigint,
	"duration_ms" bigint,
	"thumb_key" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" IN ('image','video','voice')),
	CONSTRAINT "media_status_check" CHECK ("media"."status" IN ('processing','ready','failed'))
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_media_message" ON "media" USING btree ("message_id");