CREATE ROLE restaurant_a LOGIN PASSWORD 'demo-a-db-only-not-for-production';
CREATE DATABASE restaurant_a OWNER restaurant_a;
REVOKE CONNECT ON DATABASE restaurant_a FROM PUBLIC;
GRANT CONNECT ON DATABASE restaurant_a TO restaurant_a;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
