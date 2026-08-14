ALTER TABLE "embeds" DROP CONSTRAINT "embeds_provider_check";--> statement-breakpoint
ALTER TABLE "embeds" DROP CONSTRAINT "embeds_action_type_check";--> statement-breakpoint
ALTER TABLE "embeds" ADD CONSTRAINT "embeds_provider_check" CHECK ("embeds"."provider" IN ('instagram','vault','klipy'));--> statement-breakpoint
ALTER TABLE "embeds" ADD CONSTRAINT "embeds_action_type_check" CHECK ("embeds"."action_type" IN ('external','read','portal','inline'));