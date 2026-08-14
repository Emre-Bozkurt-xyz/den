CREATE TABLE "gif_favorites" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gif_favorites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"provider_item_id" text,
	"preview_url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gif_favorites_provider_check" CHECK ("gif_favorites"."provider" IN ('klipy'))
);
--> statement-breakpoint
ALTER TABLE "gif_favorites" ADD CONSTRAINT "gif_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gif_favorites_user_item" ON "gif_favorites" USING btree ("user_id","provider","provider_ref");--> statement-breakpoint
CREATE INDEX "idx_gif_favorites_user" ON "gif_favorites" USING btree ("user_id","id" DESC NULLS LAST);