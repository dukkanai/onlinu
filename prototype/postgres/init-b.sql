CREATE ROLE restaurant_b LOGIN PASSWORD 'demo-b-db-only-not-for-production';
CREATE DATABASE restaurant_b OWNER restaurant_b;
REVOKE CONNECT ON DATABASE restaurant_b FROM PUBLIC;
GRANT CONNECT ON DATABASE restaurant_b TO restaurant_b;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
