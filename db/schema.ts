import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Manually saved trials are distinct from immutable 17:00 purchase snapshots.
export const savedPurchaseTrials = sqliteTable(
  "saved_purchase_trials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    lotteryDate: text("lottery_date").notNull(),
    createdAt: text("created_at").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [index("idx_saved_purchase_trials_user_created").on(table.userId, table.createdAt)],
);
