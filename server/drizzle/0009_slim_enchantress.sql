CREATE TABLE "embeds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "embeds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"title" text,
	"subtitle" text,
	"description" text,
	"thumb_key" text,
	"canonical_url" text,
	"provider_ref" text,
	"content_kind" text,
	"action_type" text DEFAULT 'external' NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeds_provider_check" CHECK ("embeds"."provider" IN ('instagram','vault')),
	CONSTRAINT "embeds_status_check" CHECK ("embeds"."status" IN ('processing','ready','failed')),
	CONSTRAINT "embeds_action_type_check" CHECK ("embeds"."action_type" IN ('external','read','portal'))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_kind_check";--> statement-breakpoint
ALTER TABLE "embeds" ADD CONSTRAINT "embeds_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_embeds_message" ON "embeds" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind_check" CHECK ("messages"."kind" IN ('text','image','video','voice','embed','system'));