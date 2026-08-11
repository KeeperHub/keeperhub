CREATE TABLE "agent_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	"chain_id" integer DEFAULT 1 NOT NULL,
	"registry_address" text NOT NULL
);
