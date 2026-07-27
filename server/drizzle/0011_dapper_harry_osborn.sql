CREATE TABLE "chat_vault_docs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_vault_docs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" bigint NOT NULL,
	"vault_document_id" text NOT NULL,
	"title" text,
	"added_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_vault_groups" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"vault_group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_vault_docs" ADD CONSTRAINT "chat_vault_docs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_vault_docs" ADD CONSTRAINT "chat_vault_docs_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_vault_groups" ADD CONSTRAINT "chat_vault_groups_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_vault_docs_unique" ON "chat_vault_docs" USING btree ("chat_id","vault_document_id");--> statement-breakpoint
CREATE INDEX "idx_chat_vault_docs_chat" ON "chat_vault_docs" USING btree ("chat_id");