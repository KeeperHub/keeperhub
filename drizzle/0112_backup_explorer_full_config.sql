ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_api_key_needed" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_api_key" text;--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_url" text;--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_tx_path" text;--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_address_path" text;--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD COLUMN "backup_explorer_contract_path" text;
