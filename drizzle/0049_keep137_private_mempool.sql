ALTER TABLE "chains" ADD COLUMN "use_private_mempool_rpc" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "default_private_rpc_url" text;