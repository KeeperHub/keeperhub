import "dotenv/config";
import "@/plugins";
import { vi } from "vitest";

// Set default environment variables (only if not already set)
// dotenv/config loads .env first, these are fallbacks for CI or missing .env
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/keeperhub";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_REGION ??= "us-east-1";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.SQS_QUEUE_URL ??=
  "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue";
process.env.KEEPERHUB_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_BILLING_ENABLED ??= "true";
process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED ??= "true";
process.env.TRIALS_ENABLED ??= "true";
process.env.STRIPE_SECRET_KEY ??= "sk_test_fake_key_for_tests";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_fake_secret";
process.env.STRIPE_PRICE_PRO_25K_MONTHLY ??= "price_pro_25k_monthly";
process.env.STRIPE_PRICE_PRO_25K_YEARLY ??= "price_pro_25k_yearly";
process.env.STRIPE_PRICE_PRO_50K_MONTHLY ??= "price_pro_50k_monthly";
process.env.STRIPE_PRICE_PRO_50K_YEARLY ??= "price_pro_50k_yearly";
process.env.STRIPE_PRICE_PRO_100K_MONTHLY ??= "price_pro_100k_monthly";
process.env.STRIPE_PRICE_PRO_100K_YEARLY ??= "price_pro_100k_yearly";
process.env.STRIPE_PRICE_BUSINESS_250K_MONTHLY ??= "price_biz_250k_monthly";
process.env.STRIPE_PRICE_BUSINESS_250K_YEARLY ??= "price_biz_250k_yearly";
process.env.STRIPE_PRICE_BUSINESS_500K_MONTHLY ??= "price_biz_500k_monthly";
process.env.STRIPE_PRICE_BUSINESS_500K_YEARLY ??= "price_biz_500k_yearly";
process.env.STRIPE_PRICE_BUSINESS_1M_MONTHLY ??= "price_biz_1m_monthly";
process.env.STRIPE_PRICE_BUSINESS_1M_YEARLY ??= "price_biz_1m_yearly";
process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ??= "price_ent_monthly";
process.env.STRIPE_PRICE_ENTERPRISE_YEARLY ??= "price_ent_yearly";

// Global test utilities
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      workflowSchedules: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      workflowExecutions: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));
