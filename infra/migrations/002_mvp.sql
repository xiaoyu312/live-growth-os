BEGIN;
CREATE TABLE IF NOT EXISTS mvp_products (
  product_id text PRIMARY KEY,
  name text NOT NULL,
  product_type text NOT NULL CHECK (product_type IN ('low_price_new_customer', 'high_price_repeat_customer')),
  price_fen integer NOT NULL CHECK (price_fen >= 0),
  enabled boolean NOT NULL DEFAULT true,
  note text
);
COMMIT;
