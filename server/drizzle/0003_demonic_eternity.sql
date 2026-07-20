CREATE TABLE "media_tags" (
	"media_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	"tagged_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_tags_media_id_tag_id_pk" PRIMARY KEY("media_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" bigint NOT NULL,
	"name" "citext" NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tagged_by_users_id_fk" FOREIGN KEY ("tagged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_media_tags_tag" ON "media_tags" USING btree ("tag_id","media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_chat_id_name_unique" ON "tags" USING btree ("chat_id","name");