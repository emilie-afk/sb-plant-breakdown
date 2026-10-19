-- ============================================================
-- 0005 — market data (ShipStation Product Sales) and SKUs
--
-- Market reports are stored with source = 'market' and scope
-- 'shipstation_product_sales': one row per product per store (vendor = the
-- store name), product level only. No order numbers, no customer data.
-- ============================================================
ALTER TABLE report_rows ADD COLUMN sku TEXT;
