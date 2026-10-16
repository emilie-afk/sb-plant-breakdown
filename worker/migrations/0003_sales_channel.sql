-- Shopify reports grouped by sales channel hold one row per product per
-- channel. Amazon orders arrive in Shopify through Sellbrite (from 2026-03),
-- and the channel is what keeps them apart from own-store sales.
ALTER TABLE report_rows ADD COLUMN sales_channel TEXT;
