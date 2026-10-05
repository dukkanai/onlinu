-- Synthetic-only credentials, confined to the prototype's private network.
CREATE ROLE prototype_app LOGIN PASSWORD 'demo-platform-db-only-not-for-production';
CREATE DATABASE prototype_platform OWNER prototype_app;
REVOKE CONNECT ON DATABASE prototype_platform FROM PUBLIC;
GRANT CONNECT ON DATABASE prototype_platform TO prototype_app;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
